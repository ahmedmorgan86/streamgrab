// ── Threads Handler v5 — Anti-429 ──────────────────────────────────────
// Ahmed Morgan - StreamGrab
const https = require('https');
const { exec } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

function shortcodeToId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = BigInt(0);
  for (const char of shortcode) {
    n = n * BigInt(64) + BigInt(alphabet.indexOf(char));
  }
  return n.toString();
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function httpsGet(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(httpsGet(next, headers, redirectCount + 1));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// استخرج الـ video URLs من HTML
function extractVideoUrls(html) {
  const urls = new Set();
  const patterns = [
    /["']?(https:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*)/g,
    /"video_url":"(https:\\\/\\\/[^"]+)"/g,
    /"playback_url":"(https:\\\/\\\/[^"]+)"/g,
    /contentUrl["\s:]+["'](https:[^"']+\.mp4[^"']*)/gi,
    /"src":"(https:\\\/\\\/[^"]+video[^"]+)"/g,
  ];
  for (const pat of patterns) {
    for (const m of html.matchAll(pat)) {
      const u = (m[1] || m[0])
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/')
        .replace(/\\/g, '')
        .replace(/&amp;/g, '&');
      if (u.startsWith('https://') && u.length > 30) urls.add(u);
    }
  }
  // JSON-LD
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      [j.contentUrl, j.video?.contentUrl, j.video?.url].filter(Boolean).forEach(u => urls.add(u));
    } catch {}
  }
  // og:video
  const ogV = html.match(/<meta[^>]+property="og:video(?::url)?"[^>]+content="([^"]+)"/);
  if (ogV) urls.add(ogV[1].replace(/&amp;/g, '&'));

  return [...urls].filter(u => u.includes('.mp4') || u.includes('/video/') || u.includes('video_dashinit'));
}

// Strategy 1: Embed مع retry وUA rotation
async function tryEmbed(shortcode, attempt = 0) {
  const urls = [
    `https://www.threads.net/@x/post/${shortcode}/embed`,
    `https://www.threads.com/@x/post/${shortcode}/embed`,
    `https://www.threads.net/t/${shortcode}/embed`,
  ];
  const url = urls[attempt % urls.length];

  if (attempt > 0) await sleep(1500 * attempt); // delay متزايد

  const res = await httpsGet(url, {
    'User-Agent': randomUA(),
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://www.threads.net/',
  });

  if (res.status === 429 && attempt < 3) {
    await sleep(3000 * (attempt + 1));
    return tryEmbed(shortcode, attempt + 1);
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

  const videoUrls = extractVideoUrls(res.body);
  const title   = (res.body.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/) || [])[1]?.replace(/&amp;/g,'&').replace(/&#39;/g,"'") || 'Threads Video';
  const thumb   = (res.body.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) || [])[1]?.replace(/&amp;/g,'&') || '';
  const author  = (res.body.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/) || [])[1]?.replace(/ on Threads$/,'') || '';

  if (videoUrls.length === 0) {
    // شوف لو post صورة
    if (!res.body.includes('video') && !res.body.includes('.mp4')) {
      throw new Error('هذا المنشور لا يحتوي على فيديو (صورة أو نص)');
    }
    throw new Error(`لم يتم العثور على رابط الفيديو (HTML: ${res.body.length} chars)`);
  }

  return { videoUrls, title, thumbnail: thumb, uploader: author };
}

// Strategy 2: yt-dlp مع cookies
function tryYtDlp(url) {
  return new Promise((resolve, reject) => {
    const cookiesEnv = process.env.THREADS_COOKIES || process.env.IG_COOKIES;
    let cookiesFlag  = '';
    let tmpFile      = null;

    if (cookiesEnv) {
      tmpFile = path.join(os.tmpdir(), `ig_${Date.now()}.txt`);
      try {
        fs.writeFileSync(tmpFile, cookiesEnv.startsWith('# Netscape') ? cookiesEnv : '# Netscape HTTP Cookie File\n' + cookiesEnv);
        cookiesFlag = `--cookies "${tmpFile}"`;
      } catch {}
    }

    const cmd = [
      'yt-dlp --dump-json --no-playlist --no-check-certificates',
      `--user-agent "${randomUA()}"`,
      '--add-header "Referer:https://www.threads.com/"',
      '--add-header "Accept-Language:en-US,en;q=0.9"',
      '--sleep-requests 1',
      cookiesFlag,
      JSON.stringify(url),
    ].filter(Boolean).join(' ');

    exec(cmd, { maxBuffer: 5 * 1024 * 1024, timeout: 35000 }, (err, stdout, stderr) => {
      if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
      if (err) return reject(new Error('yt-dlp: ' + stderr.replace(/WARNING[^\n]*/g,'').trim().slice(0,200)));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('yt-dlp: invalid JSON')); }
    });
  });
}

async function getThreadsInfo(url) {
  const match = url.match(/\/post\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('رابط Threads غير صحيح');
  const shortcode = match[1];
  const mediaId   = shortcodeToId(shortcode);
  const errors    = [];

  // Strategy 1: Embed scraping مع retry
  try {
    const { videoUrls, title, thumbnail, uploader } = await tryEmbed(shortcode);
    const formats = videoUrls.map((u, i) => ({
      format_id:  String(i),
      ext:        'mp4',
      resolution: i === 0 ? '1080x1920' : '720x1280',
      height:     i === 0 ? 1080 : 720,
      width:      i === 0 ? 608  : 405,
      filesize:   null, vcodec: 'avc1', acodec: 'mp4a',
      tbr:        null, fps: 30, type: 'video', url: u,
      _directUrl: u,
    }));
    return { id: mediaId, title, thumbnail, duration: null, uploader, view_count: null, upload_date: '', formats };
  } catch (e) { errors.push('Embed: ' + e.message); }

  // Strategy 2: yt-dlp
  try {
    const data    = await tryYtDlp(url);
    const formats = (data.formats || [])
      .filter(f => f.ext && (f.vcodec !== 'none' || f.acodec !== 'none'))
      .map(f => ({
        format_id: f.format_id, ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : 'audio only'),
        fps: f.fps || null, filesize: f.filesize || null,
        vcodec: f.vcodec, acodec: f.acodec,
        tbr: f.tbr || null, abr: f.abr || null,
        height: f.height || null,
        type: f.vcodec === 'none' ? 'audio' : 'video',
        _directUrl: f.url || null,
      })).sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
    return {
      id: data.id, title: data.title, thumbnail: data.thumbnail,
      duration: data.duration, uploader: data.uploader,
      view_count: data.view_count, upload_date: data.upload_date, formats,
    };
  } catch (e) { errors.push(e.message); }

  throw new Error('فشل تحميل Threads:\n' + errors.join('\n'));
}

module.exports = { getThreadsInfo, shortcodeToId };

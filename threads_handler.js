// ── Threads Handler v6 — scontent CDN ──────────────────────────────────
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
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const randUA = ()  => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

function httpsGet(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(httpsGet(next, headers, redirects + 1));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractVideoUrls(html) {
  const urls = new Set();

  // scontent CDN - الـ pattern الحقيقي من الـ HTML بتاع Threads
  const regexes = [
    /"(https:\/\/scontent[^"]+\.mp4[^"]*)"/g,
    /'(https:\/\/scontent[^']+\.mp4[^']*)'/g,
    /src="(https:\/\/scontent[^"]+\.mp4[^"]*)"/g,
    /src='(https:\/\/scontent[^']+\.mp4[^']*)'/g,
    /"(https:\/\/[^"]*cdninstagram\.com[^"]*\.mp4[^"]*)"/g,
    /"(https:\/\/[^"]*\.fbcdn\.net[^"]*\.mp4[^"]*)"/g,
    /"video_url":"(https:\/\/[^"]+)"/g,
    /"playback_url":"(https:\/\/[^"]+)"/g,
  ];

  for (const re of regexes) {
    for (const m of html.matchAll(re)) {
      let u = m[1];
      // unescape
      u = u.replace(/&amp;/g, '&').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      if (u && u.startsWith('https://') && u.length > 60) {
        urls.add(u);
      }
    }
  }

  // JSON-LD
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      [j.contentUrl, j?.video?.contentUrl, j?.video?.url]
        .filter(Boolean).forEach(u => urls.add(u));
    } catch {}
  }

  // og:video
  const ogV = html.match(/<meta[^>]+property="og:video(?::url)?"[^>]+content="([^"]+)"/);
  if (ogV) urls.add(ogV[1].replace(/&amp;/g, '&'));

  return [...urls].filter(u =>
    u.includes('.mp4') &&
    !u.includes('.css') &&
    !u.includes('.js') &&
    u.length > 60
  );
}

async function tryEmbed(shortcode, attempt = 0) {
  const embedUrls = [
    `https://www.threads.net/@x/post/${shortcode}/embed`,
    `https://www.threads.com/@x/post/${shortcode}/embed`,
  ];
  const url = embedUrls[attempt % embedUrls.length];

  if (attempt > 0) await sleep(2000 * attempt);

  const res = await httpsGet(url, {
    'User-Agent': randUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.threads.net/',
    'Cache-Control': 'no-cache',
  });

  if (res.status === 429 && attempt < 3) {
    await sleep(3000 * (attempt + 1));
    return tryEmbed(shortcode, attempt + 1);
  }

  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

  const videoUrls = extractVideoUrls(res.body);

  const title = (
    res.body.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/) ||
    res.body.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)
  )?.[1]?.replace(/&amp;/g, '&').replace(/&#39;/g, "'") || 'Threads Video';

  const thumbnail = res.body.match(
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/
  )?.[1]?.replace(/&amp;/g, '&') || '';

  const uploader = res.body.match(
    /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/
  )?.[1]?.replace(/ on Threads$/, '') || '';

  if (videoUrls.length === 0) {
    throw new Error(`لم يتم العثور على رابط الفيديو في HTML (${res.body.length} chars)`);
  }

  return { videoUrls, title, thumbnail, uploader };
}

function tryYtDlp(url) {
  return new Promise((resolve, reject) => {
    const cookiesEnv = process.env.THREADS_COOKIES || process.env.IG_COOKIES;
    let cookiesFlag  = '';
    let tmpFile      = null;

    if (cookiesEnv) {
      tmpFile = path.join(os.tmpdir(), `ig_${Date.now()}.txt`);
      try {
        fs.writeFileSync(
          tmpFile,
          cookiesEnv.startsWith('# Netscape') ? cookiesEnv : '# Netscape HTTP Cookie File\n' + cookiesEnv
        );
        cookiesFlag = `--cookies "${tmpFile}"`;
      } catch {}
    }

    const cmd = [
      'yt-dlp --dump-json --no-playlist --no-check-certificates',
      `--user-agent "${randUA()}"`,
      '--add-header "Referer:https://www.threads.com/"',
      '--add-header "Accept-Language:en-US,en;q=0.9"',
      cookiesFlag,
      JSON.stringify(url),
    ].filter(Boolean).join(' ');

    exec(cmd, { maxBuffer: 5 * 1024 * 1024, timeout: 35000 }, (err, stdout, stderr) => {
      if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
      if (err) return reject(new Error('yt-dlp: ' + stderr.replace(/WARNING[^\n]*/g, '').trim().slice(0, 200)));
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

  // Strategy 1: Embed scraping
  try {
    const { videoUrls, title, thumbnail, uploader } = await tryEmbed(shortcode);
    const formats = videoUrls.map((u, i) => ({
      format_id:   String(i),
      ext:         'mp4',
      resolution:  i === 0 ? '1080x1920' : '720x1280',
      height:      i === 0 ? 1080 : 720,
      width:       i === 0 ? 608  : 405,
      filesize:    null,
      vcodec:      'avc1',
      acodec:      'mp4a',
      tbr:         null,
      fps:         30,
      type:        'video',
      _directUrl:  u,
    }));
    return { id: mediaId, title, thumbnail, duration: null, uploader, view_count: null, upload_date: '', formats };
  } catch (e) { errors.push('Embed: ' + e.message); }

  // Strategy 2: yt-dlp
  try {
    const data    = await tryYtDlp(url);
    const formats = (data.formats || [])
      .filter(f => f.ext && (f.vcodec !== 'none' || f.acodec !== 'none'))
      .map(f => ({
        format_id:  f.format_id,
        ext:        f.ext,
        resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : 'audio only'),
        fps:        f.fps     || null,
        filesize:   f.filesize || null,
        vcodec:     f.vcodec,
        acodec:     f.acodec,
        tbr:        f.tbr  || null,
        abr:        f.abr  || null,
        height:     f.height || null,
        type:       f.vcodec === 'none' ? 'audio' : 'video',
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

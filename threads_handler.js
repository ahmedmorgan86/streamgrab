// ── Threads Handler v4 — Embed Scraper ──────────────────────────────────
// Ahmed Morgan - StreamGrab
const https  = require('https');
const { exec } = require('child_process');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

function shortcodeToId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = BigInt(0);
  for (const char of shortcode) {
    n = n * BigInt(64) + BigInt(alphabet.indexOf(char));
  }
  return n.toString();
}

function httpsGet(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
        ...headers,
      },
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(httpsGet(next, headers, redirectCount + 1));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Strategy 1: Threads Embed Page
async function tryEmbedScrape(shortcode) {
  const embedUrl = `https://www.threads.net/@x/post/${shortcode}/embed`;
  const res = await httpsGet(embedUrl, {
    'Referer': 'https://www.threads.net/',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
  });

  if (res.status !== 200) throw new Error(`Embed page: HTTP ${res.status}`);

  const html = res.body;

  // ابحث عن video source URLs
  const videoPatterns = [
    /video_url":"(https:\\\/\\\/[^"]+\.mp4[^"]*)"/g,
    /"src":"(https:\\\/\\\/[^"]+\.mp4[^"]*)"/g,
    /src="(https:\/\/[^"]+\.mp4[^"]*)"/g,
    /https:\/\/[^\s"'<>]+\.mp4[\?][^\s"'<>]*/g,
    /"playback_url":"(https:[^"]+)"/g,
    /contentUrl["\s:]+["'](https:[^"']+)/g,
  ];

  const videoUrls = new Set();
  for (const pat of videoPatterns) {
    for (const m of html.matchAll(pat)) {
      const u = (m[1] || m[0]).replace(/\\u0026/g, '&').replace(/\\/g, '').replace(/&amp;/g, '&');
      if (u.includes('http') && (u.includes('.mp4') || u.includes('video'))) {
        videoUrls.add(u);
      }
    }
  }

  // ابحث في JSON-LD
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonLdMatch) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      if (jsonLd.contentUrl) videoUrls.add(jsonLd.contentUrl);
      if (jsonLd.video?.contentUrl) videoUrls.add(jsonLd.video.contentUrl);
    } catch {}
  }

  // ابحث في meta tags
  const ogVideo = html.match(/<meta property="og:video(?::url)?" content="([^"]+)"/);
  if (ogVideo) videoUrls.add(ogVideo[1].replace(/&amp;/g, '&'));

  // جيب الـ metadata
  const titleMatch  = html.match(/<meta property="og:description" content="([^"]*)"/);
  const thumbMatch  = html.match(/<meta property="og:image" content="([^"]+)"/);
  const authorMatch = html.match(/<meta property="og:title" content="([^"]+)"/);

  const title     = titleMatch  ? titleMatch[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'") : 'Threads Video';
  const thumbnail = thumbMatch  ? thumbMatch[1].replace(/&amp;/g, '&') : '';
  const uploader  = authorMatch ? authorMatch[1].replace(/ on Threads$/, '') : '';

  if (videoUrls.size === 0) {
    // لو مفيش mp4 - ممكن يكون صورة مش فيديو
    const isImage = html.includes('og:type" content="article') && !html.includes('.mp4');
    if (isImage) throw new Error('هذا الـ post صورة وليس فيديو');
    throw new Error(`لم يتم العثور على فيديو في الـ embed page (HTML length: ${html.length})`);
  }

  const urls = [...videoUrls];
  return {
    videoUrls: urls,
    title,
    thumbnail,
    uploader,
  };
}

// Strategy 2: yt-dlp مع cookies من env
function tryYtDlpWithCookies(url) {
  return new Promise((resolve, reject) => {
    const cookiesEnv = process.env.THREADS_COOKIES || process.env.IG_COOKIES;
    let cookiesFlag  = '';

    if (cookiesEnv) {
      const tmpFile = path.join(os.tmpdir(), `ig_cookies_${Date.now()}.txt`);
      try {
        const content = cookiesEnv.startsWith('# Netscape')
          ? cookiesEnv
          : '# Netscape HTTP Cookie File\n' + cookiesEnv;
        fs.writeFileSync(tmpFile, content);
        cookiesFlag = `--cookies "${tmpFile}"`;
      } catch {}
    }

    const safeUrl = JSON.stringify(url);
    const cmd = [
      'yt-dlp --dump-json --no-playlist --no-check-certificates',
      '--user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"',
      '--add-header "Referer:https://www.threads.com/"',
      '--add-header "X-IG-App-ID:936619743392459"',
      cookiesFlag,
      safeUrl,
    ].filter(Boolean).join(' ');

    exec(cmd, { maxBuffer: 5 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
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

  // Strategy 1: Embed page scraping (بدون login)
  try {
    const { videoUrls, title, thumbnail, uploader } = await tryEmbedScrape(shortcode);
    const formats = videoUrls.map((u, i) => ({
      format_id:  encodeURIComponent(u),
      ext:        'mp4',
      resolution: i === 0 ? '1080x1920' : '720x1280',
      height:     i === 0 ? 1080 : 720,
      width:      i === 0 ? 608  : 405,
      filesize:   null,
      vcodec:     'avc1',
      acodec:     'mp4a',
      tbr:        null,
      fps:        30,
      type:       'video',
      url:        u,
    }));
    return { id: mediaId, title, thumbnail, duration: null, uploader, view_count: null, upload_date: '', formats };
  } catch (e) { errors.push('Embed: ' + e.message); }

  // Strategy 2: yt-dlp مع cookies
  try {
    const data    = await tryYtDlpWithCookies(url);
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

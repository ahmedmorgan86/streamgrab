// ── Threads Handler v2 ──────────────────────────────────────────────────
// Ahmed Morgan - StreamGrab
const https = require('https');
const { exec } = require('child_process');

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
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, headers, redirectCount + 1));
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Strategy 1: Instagram Private API
async function tryInstagramAPI(mediaId) {
  const url = `https://www.instagram.com/api/v1/media/${mediaId}/info/`;
  const res = await httpsGet(url, {
    'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100)',
    'X-IG-App-ID': '567067343352427',
    'Accept': '*/*',
    'Accept-Language': 'en-US',
    'X-FB-HTTP-Engine': 'Liger',
    'X-FB-Client-IP': 'True',
    'X-FB-Server-Cluster': 'True',
  });
  if (res.status !== 200) throw new Error(`Instagram API: ${res.status} - ${res.body.slice(0,200)}`);
  const data = JSON.parse(res.body);
  const item = data.items?.[0];
  if (!item) throw new Error('No media item in response');
  return item;
}

// Strategy 2: Threads Web Scraping
async function tryWebScrape(shortcode) {
  const url = `https://www.threads.com/@x/post/${shortcode}`;
  const res = await httpsGet(url, {
    'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  });
  if (res.status !== 200) throw new Error(`Web scrape: ${res.status}`);

  // ابحث عن video URLs في الـ HTML
  const videoUrls = [];
  const patterns = [
    /https:\/\/[^"\s]+\.mp4[^"\s]*/g,
    /"video_url":"(https:\/\/[^"]+)"/g,
    /videoUrl":"(https:\/\/[^"]+)"/g,
  ];
  for (const pat of patterns) {
    const matches = res.body.matchAll(pat);
    for (const m of matches) {
      const u = (m[1] || m[0]).replace(/\\u0026/g, '&').replace(/\\/g, '');
      if (!videoUrls.includes(u)) videoUrls.push(u);
    }
  }
  if (videoUrls.length === 0) throw new Error('No video URLs found in page HTML');

  // جيب الـ title
  const titleMatch = res.body.match(/<meta property="og:description" content="([^"]*)"/) ||
                     res.body.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/&amp;/g, '&') : 'Threads Video';

  // جيب الـ thumbnail
  const thumbMatch = res.body.match(/<meta property="og:image" content="([^"]+)"/);
  const thumbnail = thumbMatch ? thumbMatch[1] : '';

  return { videoUrls, title, thumbnail };
}

// Strategy 3: yt-dlp مع user-agent
function tryYtDlp(url) {
  return new Promise((resolve, reject) => {
    const safeUrl = JSON.stringify(url);
    const cmd = [
      'yt-dlp --dump-json --no-playlist --no-check-certificates',
      '--user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"',
      `--add-header "Referer:https://www.threads.com/"`,
      `--add-header "Accept-Language:en-US,en;q=0.9"`,
      safeUrl
    ].join(' ');

    exec(cmd, { maxBuffer: 5 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.slice(0, 300)));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('Invalid JSON from yt-dlp')); }
    });
  });
}

async function getThreadsInfo(url) {
  const match = url.match(/\/post\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('رابط Threads غير صحيح');
  const shortcode = match[1];
  const mediaId   = shortcodeToId(shortcode);

  const errors = [];

  // Strategy 1: Instagram API
  try {
    const item = await tryInstagramAPI(mediaId);
    const formats = (item.video_versions || []).map((v, i) => ({
      format_id: encodeURIComponent(v.url),
      ext: 'mp4',
      resolution: `${v.width}x${v.height}`,
      height: v.height, width: v.width,
      filesize: null, vcodec: 'avc1', acodec: 'mp4a',
      tbr: null, fps: 30, type: 'video',
      url: v.url,
    })).sort((a, b) => (b.height || 0) - (a.height || 0));

    if (formats.length === 0) throw new Error('No video formats in Instagram API response');

    return {
      id: mediaId, title: item.caption?.text?.slice(0, 100) || 'Threads Video',
      thumbnail: item.image_versions2?.candidates?.[0]?.url || '',
      duration: item.video_duration || null,
      uploader: item.user?.username || '',
      view_count: item.play_count || null,
      upload_date: String(item.taken_at || ''),
      formats,
    };
  } catch (e) { errors.push('Instagram API: ' + e.message); }

  // Strategy 2: Web Scraping
  try {
    const { videoUrls, title, thumbnail } = await tryWebScrape(shortcode);
    const formats = videoUrls.map((u, i) => ({
      format_id: encodeURIComponent(u),
      ext: 'mp4', resolution: i === 0 ? '1080p' : '720p',
      height: i === 0 ? 1080 : 720, width: i === 0 ? 608 : 405,
      filesize: null, vcodec: 'avc1', acodec: 'mp4a',
      tbr: null, fps: 30, type: 'video', url: u,
    }));
    return { id: mediaId, title, thumbnail, duration: null, uploader: '', view_count: null, upload_date: '', formats };
  } catch (e) { errors.push('Web scrape: ' + e.message); }

  // Strategy 3: yt-dlp fallback
  try {
    const data = await tryYtDlp(url);
    const formats = (data.formats || [])
      .filter(f => f.ext && (f.vcodec !== 'none' || f.acodec !== 'none'))
      .map(f => ({
        format_id: f.format_id, ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : 'audio only'),
        fps: f.fps || null, filesize: f.filesize || null,
        vcodec: f.vcodec, acodec: f.acodec,
        tbr: f.tbr || null, abr: f.abr || null,
        height: f.height || null, type: f.vcodec === 'none' ? 'audio' : 'video',
      })).sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
    return {
      id: data.id, title: data.title, thumbnail: data.thumbnail,
      duration: data.duration, uploader: data.uploader,
      view_count: data.view_count, upload_date: data.upload_date, formats,
    };
  } catch (e) { errors.push('yt-dlp: ' + e.message); }

  throw new Error('كل المحاولات فشلت:\n' + errors.join('\n'));
}

module.exports = { getThreadsInfo, shortcodeToId };

// ── Threads Handler v3 — Cookie-based ──────────────────────────────────
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

// اكتب cookies من env variable لملف مؤقت
function getCookiesFile() {
  const cookiesEnv = process.env.THREADS_COOKIES || process.env.IG_COOKIES;
  if (!cookiesEnv) return null;
  const tmpFile = path.join(os.tmpdir(), 'threads_cookies.txt');
  try {
    // لو الـ cookies بـ Netscape format أو JSON
    let content = cookiesEnv;
    if (!content.startsWith('# Netscape')) {
      // حاول تحوّله لـ Netscape format
      content = '# Netscape HTTP Cookie File\n' + content;
    }
    fs.writeFileSync(tmpFile, content);
    return tmpFile;
  } catch { return null; }
}

// Strategy 1: yt-dlp مع cookies
function tryYtDlpWithCookies(url) {
  return new Promise((resolve, reject) => {
    const cookiesFile = getCookiesFile();
    const cookiesFlag = cookiesFile ? `--cookies "${cookiesFile}"` : '';
    const safeUrl = JSON.stringify(url);
    const cmd = [
      'yt-dlp --dump-json --no-playlist --no-check-certificates',
      '--user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"',
      '--add-header "Referer:https://www.threads.com/"',
      '--add-header "Accept-Language:en-US,en;q=0.9"',
      '--add-header "X-IG-App-ID:936619743392459"',
      cookiesFlag,
      safeUrl,
    ].filter(Boolean).join(' ');

    exec(cmd, { maxBuffer: 5 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('yt-dlp: ' + stderr.slice(0, 300)));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('yt-dlp: invalid JSON response')); }
    });
  });
}

// Strategy 2: Instagram API مع cookies
function tryInstagramAPIWithCookies(mediaId) {
  return new Promise((resolve, reject) => {
    const cookiesEnv = process.env.THREADS_COOKIES || process.env.IG_COOKIES || '';
    
    // استخرج sessionid و csrftoken من cookies
    const sessionMatch = cookiesEnv.match(/sessionid[=\t]([^\s;\n]+)/);
    const csrfMatch    = cookiesEnv.match(/csrftoken[=\t]([^\s;\n]+)/);
    const sessionid    = sessionMatch ? sessionMatch[1] : '';
    const csrftoken    = csrfMatch    ? csrfMatch[1]    : '';

    if (!sessionid) return reject(new Error('No Instagram session cookie'));

    const cookieStr = `sessionid=${sessionid}; csrftoken=${csrftoken}`;
    const url = `https://www.instagram.com/api/v1/media/${mediaId}/info/`;

    const req = https.get(url, {
      headers: {
        'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B)',
        'X-IG-App-ID': '567067343352427',
        'Cookie': cookieStr,
        'X-CSRFToken': csrftoken,
        'Referer': 'https://www.threads.com/',
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`API ${res.statusCode}: ${data.slice(0,200)}`));
        try {
          const json = JSON.parse(data);
          const item = json.items?.[0];
          if (!item) return reject(new Error('No media item'));
          resolve(item);
        } catch { reject(new Error('Invalid JSON from API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getThreadsInfo(url) {
  const match = url.match(/\/post\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('رابط Threads غير صحيح — تأكد من نسخ الرابط كامل');
  const shortcode = match[1];
  const mediaId   = shortcodeToId(shortcode);
  const errors    = [];
  const hasCookies = !!(process.env.THREADS_COOKIES || process.env.IG_COOKIES);

  // Strategy 1: yt-dlp مع cookies (لو موجودة)
  if (hasCookies) {
    try {
      const data = await tryYtDlpWithCookies(url);
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
        })).sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
      return {
        id: data.id, title: data.title, thumbnail: data.thumbnail,
        duration: data.duration, uploader: data.uploader,
        view_count: data.view_count, upload_date: data.upload_date, formats,
      };
    } catch (e) { errors.push(e.message); }

    // Strategy 2: Instagram API مع cookies
    try {
      const item = await tryInstagramAPIWithCookies(mediaId);
      const formats = (item.video_versions || []).map((v) => ({
        format_id: encodeURIComponent(v.url),
        ext: 'mp4', resolution: `${v.width}x${v.height}`,
        height: v.height, width: v.width, filesize: null,
        vcodec: 'avc1', acodec: 'mp4a', tbr: null, fps: 30,
        type: 'video', url: v.url,
      })).sort((a, b) => (b.height || 0) - (a.height || 0));

      if (formats.length === 0) throw new Error('No video formats');
      return {
        id: mediaId, title: item.caption?.text?.slice(0, 100) || 'Threads Video',
        thumbnail: item.image_versions2?.candidates?.[0]?.url || '',
        duration: item.video_duration || null,
        uploader: item.user?.username || '',
        view_count: item.play_count || null,
        upload_date: String(item.taken_at || ''), formats,
      };
    } catch (e) { errors.push(e.message); }
  }

  // لو مفيش cookies - رسالة واضحة
  throw new Error(
    hasCookies
      ? 'فشل تحميل Threads:\n' + errors.join('\n')
      : 'تحميل Threads يحتاج إعداد THREADS_COOKIES على السيرفر — راجع التعليمات'
  );
}

module.exports = { getThreadsInfo, shortcodeToId };

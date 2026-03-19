// ── Threads Handler ──────────────────────────────────────────────────────
const https = require('https');

function shortcodeToId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = BigInt(0);
  for (const char of shortcode) {
    n = n * BigInt(64) + BigInt(alphabet.indexOf(char));
  }
  return n.toString();
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Site': 'same-origin',
        ...headers,
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, headers));
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function getThreadsInfo(url) {
  // استخرج الـ shortcode من الـ URL
  const match = url.match(/\/post\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('رابط Threads غير صحيح');
  const shortcode = match[1];
  const mediaId   = shortcodeToId(shortcode);

  // جرب Instagram oEmbed API (بيشتغل مع Threads كمان)
  const oembedUrl = `https://www.instagram.com/api/v1/media/${mediaId}/info/`;
  const igHeaders = {
    'X-IG-App-ID': '936619743392459',
    'X-ASBD-ID': '129477',
    'X-IG-WWW-Claim': '0',
    'Origin': 'https://www.threads.com',
    'Referer': 'https://www.threads.com/',
  };

  const res = await httpsGet(oembedUrl, igHeaders);
  if (res.status !== 200) throw new Error(`Instagram API أرجع ${res.status}`);

  const data = JSON.parse(res.body);
  const item = data.items?.[0];
  if (!item) throw new Error('مفيش بيانات للفيديو');

  // جمع الـ video candidates
  const formats = [];
  const videos  = item.video_versions || [];
  for (const v of videos) {
    formats.push({
      format_id:  String(v.type || formats.length),
      ext:        'mp4',
      resolution: `${v.width}x${v.height}`,
      height:     v.height,
      width:      v.width,
      filesize:   null,
      vcodec:     'avc1',
      acodec:     'mp4a',
      tbr:        null,
      fps:        item.video_duration ? 30 : null,
      type:       'video',
      url:        v.url,
    });
  }
  formats.sort((a, b) => (b.height || 0) - (a.height || 0));

  const thumb = item.image_versions2?.candidates?.[0]?.url || '';
  return {
    id:         mediaId,
    title:      item.caption?.text?.slice(0, 100) || 'Threads Video',
    thumbnail:  thumb,
    duration:   item.video_duration || null,
    uploader:   item.user?.username || '',
    view_count: item.play_count    || null,
    upload_date:String(item.taken_at || ''),
    formats,
    _threadsVideoUrls: formats.map(f => f.url),
  };
}

module.exports = { getThreadsInfo, shortcodeToId };

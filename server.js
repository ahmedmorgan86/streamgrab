const express    = require('express');
const cors       = require('cors');
const { exec }   = require('child_process');
const path       = require('path');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');
const { getThreadsInfo } = require('./threads_handler');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TMP = '/tmp';

// ── Video URL Cache (للـ Threads وغيره من الروابط المباشرة) ───────────────
const videoUrlCache = new Map();
function cacheVideoUrl(url) {
  const id = 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  videoUrlCache.set(id, { url, expires: Date.now() + 10 * 60 * 1000 }); // 10 دقايق
  return id;
}
function getCachedUrl(id) {
  const entry = videoUrlCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expires) { videoUrlCache.delete(id); return null; }
  return entry.url;
}
// نظّف الـ cache كل 5 دقايق
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of videoUrlCache) {
    if (now > v.expires) videoUrlCache.delete(k);
  }
}, 5 * 60 * 1000);

// ── Rate Limiting ──────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'كثير من الطلبات، انتظر دقيقة وحاول مجدداً' },
});
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'تجاوزت الحد المسموح به للتحميل، انتظر دقيقة' },
});
app.use('/info',              limiter);
app.use('/download-progress', downloadLimiter);
app.use('/get-file',          limiter);

// ── Domain Whitelist ───────────────────────────────────────────────────────
const ALLOWED_DOMAINS = [
  'youtube.com','youtu.be',
  'tiktok.com',
  'instagram.com',
  'threads.net',
  'threads.com',
  'facebook.com','fb.watch',
  'twitter.com','x.com','t.co',
  'vimeo.com',
  'twitch.tv',
  'dailymotion.com',
  'soundcloud.com',
  'reddit.com',
  'bilibili.com',
  'rumble.com',
  'pinterest.com',
  'linkedin.com',
  'snapchat.com',
  'streamable.com',
  'medal.tv',
  'kick.com',
];

function isAllowedUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '');
    return ALLOWED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

function sanitizeFilename(name) {
  return String(name || 'media').replace(/[^a-z0-9_\-.\u0600-\u06FF]/gi, '_').slice(0, 120);
}

function isSafeTmpPath(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.startsWith('/tmp/') && !resolved.includes('..');
}


// ── Extra yt-dlp flags per domain ─────────────────────────────────────────
function getExtraFlags(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '');
    if (host === 'threads.com' || host === 'threads.net') {
      // Threads محتاج User-Agent خاص وبيشتغل عبر Instagram extractor
      return [
        '--add-header', '"User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"',
        '--add-header', '"Accept-Language:en-US,en;q=0.9"',
        '--extractor-args', '"instagram:api_page_id=threads"',
      ].join(' ');
    }
    if (host === 'instagram.com') {
      return '--add-header "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"';
    }
  } catch {}
  return '';
}

// ── GET /info ──────────────────────────────────────────────────────────────
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url)               return res.status(400).json({ error: 'URL مطلوب' });
  if (!isAllowedUrl(url)) return res.status(400).json({ error: 'هذا الموقع غير مدعوم أو غير مسموح به' });

  // ── Threads: handler مخصص ──────────────────────────────────────────────
  const urlHost = new URL(url).hostname.replace(/^www\./, '');
  if (urlHost === 'threads.com' || urlHost === 'threads.net') {
    try {
      const threadsData = await getThreadsInfo(url);
      // حوّل الـ _directUrl لـ cached ID عشان URL قصير
      threadsData.formats = threadsData.formats.map(f => {
        if (f._directUrl) {
          const cachedId = cacheVideoUrl(f._directUrl);
          return { ...f, format_id: cachedId, _directUrl: undefined };
        }
        return f;
      });
      return res.json(threadsData);
    } catch (err) {
      console.error('[Threads Error]', err.message, err.stack);
      const needsCookies = err.message.includes('THREADS_COOKIES');
      return res.status(500).json({
        error: needsCookies
          ? 'Threads يحتاج إعداد Cookies على السيرفر'
          : 'فشل تحميل الرابط من Threads',
        detail: err.message,
        needsCookies,
      });
    }
  }

  const safeUrl = JSON.stringify(url);
  const extraFlags = getExtraFlags(url);
  const cmd = `yt-dlp --dump-json --no-playlist --no-check-certificates ${extraFlags} ${safeUrl}`;

  exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'فشل تحليل الرابط', detail: stderr.slice(0, 300) });
    let data;
    try { data = JSON.parse(stdout); }
    catch { return res.status(500).json({ error: 'فشل قراءة البيانات' }); }

    const formats = (data.formats || [])
      .filter(f => f.ext && (f.vcodec !== 'none' || f.acodec !== 'none'))
      .map(f => ({
        format_id:  f.format_id,
        ext:        f.ext,
        resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : 'audio only'),
        fps:        f.fps        || null,
        filesize:   f.filesize   || f.filesize_approx || null,
        vcodec:     f.vcodec,
        acodec:     f.acodec,
        tbr:        f.tbr        || null,
        abr:        f.abr        || null,
        height:     f.height     || null,
        type:       f.vcodec === 'none' ? 'audio' : 'video',
      }))
      .sort((a, b) => (b.tbr || 0) - (a.tbr || 0));

    res.json({
      id:          data.id,
      title:       data.title,
      thumbnail:   data.thumbnail,
      duration:    data.duration,
      uploader:    data.uploader,
      view_count:  data.view_count,
      upload_date: data.upload_date,
      formats,
    });
  });
});

// ── GET /download-progress ─────────────────────────────────────────────────
app.get('/download-progress', (req, res) => {
  const { url, format_id, filename, type } = req.query;
  if (!url || !format_id)  return res.status(400).end();
  if (!isAllowedUrl(url))  return res.status(400).end();
  if (!/^[\w\+\-\.]+$/.test(format_id)) return res.status(400).end();

  // ── Threads / Direct URL: تحميل من cache ────────────────────────────────
  const dlHost = new URL(url).hostname.replace(/^www\./, '');
  const cachedVideoUrl = getCachedUrl(format_id);
  if (dlHost === 'threads.com' || dlHost === 'threads.net' || cachedVideoUrl) {
    const videoUrl = cachedVideoUrl || decodeURIComponent(format_id);
    const safeName2 = sanitizeFilename(filename);
    const outFile2  = path.join(TMP, `${Date.now()}_${safeName2}.mp4`);
    const https     = require('https');

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const send2 = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send2({ status: 'downloading', percent: 10, speed: '', eta: '' });

    const file2 = require('fs').createWriteStream(outFile2);
    https.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.threads.com/',
      }
    }, (resp) => {
      const total = parseInt(resp.headers['content-length'] || '0', 10);
      let downloaded = 0;
      resp.on('data', chunk => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = Math.min(Math.round((downloaded / total) * 99), 99);
          send2({ status: 'downloading', percent: pct, speed: '', eta: '' });
        }
      });
      resp.pipe(file2);
      file2.on('finish', () => {
        send2({ status: 'done', percent: 100, file: outFile2, filename: `${safeName2}.mp4` });
        setTimeout(() => { try { if (require('fs').existsSync(outFile2)) require('fs').unlinkSync(outFile2); } catch {} }, 5 * 60 * 1000);
        res.end();
      });
    }).on('error', (e) => {
      send2({ status: 'error', message: 'فشل تحميل الفيديو: ' + e.message });
      res.end();
    });
    return;
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const safeName = sanitizeFilename(filename);
  const ext      = type === 'audio' ? 'mp3' : 'mp4';
  const outFile  = path.join(TMP, `${Date.now()}_${safeName}.${ext}`);
  const safeUrl  = JSON.stringify(url);
  const safeOut  = JSON.stringify(outFile);

  let cmd;
  if (type === 'audio') {
    const quality = parseInt(format_id, 10);
    if (![128, 192, 256, 320].includes(quality)) return res.status(400).end();
    const ef = getExtraFlags(url);
    cmd = `yt-dlp -x --audio-format mp3 --audio-quality ${quality}k --newline --no-check-certificates ${ef} -o ${safeOut} ${safeUrl}`;
  } else {
    const safeFmt = JSON.stringify(`${format_id}+bestaudio[ext=m4a]/best[ext=mp4]/best`);
    const ef2 = getExtraFlags(url);
    cmd = `yt-dlp -f ${safeFmt} --merge-output-format mp4 --newline --no-check-certificates ${ef2} -o ${safeOut} ${safeUrl}`;
  }

  const proc = exec(cmd);

  proc.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const pctMatch   = line.match(/(\d+\.?\d*)%/);
      const speedMatch = line.match(/([\d.]+[KMG]iB\/s)/);
      const etaMatch   = line.match(/ETA\s+(\d+:\d+)/);
      if (pctMatch) send({
        status: 'downloading',
        percent: Math.min(Math.round(parseFloat(pctMatch[1])), 99),
        speed: speedMatch ? speedMatch[1] : '',
        eta:   etaMatch   ? etaMatch[1]   : '',
      });
    }
  });

  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    if (!line.includes('WARNING')) send({ status: 'log', message: line.trim().slice(0, 200) });
  });

  proc.on('close', (code) => {
    if (code === 0 && fs.existsSync(outFile)) {
      send({ status: 'done', percent: 100, file: outFile, filename: `${safeName}.${ext}` });
      setTimeout(() => { try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch {} }, 5 * 60 * 1000);
    } else {
      send({ status: 'error', message: 'فشل التحميل — تأكد من الرابط أو حدّث yt-dlp' });
    }
    res.end();
  });

  req.on('close', () => { try { proc.kill('SIGTERM'); } catch {} });
});

// ── GET /get-file ──────────────────────────────────────────────────────────
app.get('/get-file', (req, res) => {
  const { file, filename } = req.query;
  if (!file || !isSafeTmpPath(file))
    return res.status(400).json({ error: 'مسار غير صالح' });
  if (!fs.existsSync(file))
    return res.status(404).json({ error: 'الملف غير موجود أو انتهت صلاحيته' });

  const safeName = sanitizeFilename(filename) || path.basename(file);
  res.download(file, safeName, (err) => {
    if (!err) try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  });
});

// ── Debug Threads HTML ──────────────────────────────────────────────────────
app.get('/debug-threads-html', async (req, res) => {
  const shortcode = req.query.code || 'DWC549LAFPP';
  const https = require('https');
  
  function get(url) {
    return new Promise((resolve, reject) => {
      const req2 = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      }, (r) => {
        const chunks = [];
        r.on('data', d => chunks.push(d));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req2.on('error', reject);
    });
  }
  
  try {
    const r = await get(`https://www.threads.net/@x/post/${shortcode}/embed`);
    const html = r.body;
    
    // ابحث عن keywords
    const found = {};
    ['video_url','mp4','fbcdn','cdninstagram','scontent','playback','VideoObject','contentUrl'].forEach(k => {
      const idx = html.indexOf(k);
      if (idx !== -1) found[k] = html.slice(Math.max(0,idx-10), idx+200);
    });
    
    // أول 1000 char
    res.json({
      status: r.status,
      length: html.length,
      first500: html.slice(0, 500),
      keywordsFound: found,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug Threads (مؤقت) ──────────────────────────────────────────────────
app.get('/debug-threads', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({ error: 'url required' });
  try {
    const { getThreadsInfo } = require('./threads_handler');
    const data = await getThreadsInfo(url);
    res.json({ ok: true, title: data.title, formatsCount: data.formats.length });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,5) });
  }
});

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ StreamGrab API — http://localhost:${PORT}`));

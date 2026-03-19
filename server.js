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
  return String(name || 'media').replace(/[^a-z0-9_\-\u0600-\u06FF]/gi, '_').slice(0, 120);
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
      return res.json(threadsData);
    } catch (err) {
      console.error('[Threads Error]', err.message, err.stack);
      return res.status(500).json({
        error: 'فشل تحميل الرابط من Threads',
        detail: err.message,
        hint: 'تأكد أن الرابط صح وأن الـ post مش private'
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

  // ── Threads: تحميل مباشر بدون yt-dlp ────────────────────────────────────
  const dlHost = new URL(url).hostname.replace(/^www\./, '');
  if (dlHost === 'threads.com' || dlHost === 'threads.net') {
    // format_id هنا هو URL المشفّر للفيديو المباشر
    const videoUrl = decodeURIComponent(format_id);
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

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ StreamGrab API — http://localhost:${PORT}`));

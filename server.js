const express    = require('express');
const cors       = require('cors');
const { exec }   = require('child_process');
const path       = require('path');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');

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

// ── GET /info ──────────────────────────────────────────────────────────────
app.get('/info', (req, res) => {
  const { url } = req.query;
  if (!url)               return res.status(400).json({ error: 'URL مطلوب' });
  if (!isAllowedUrl(url)) return res.status(400).json({ error: 'هذا الموقع غير مدعوم أو غير مسموح به' });

  const safeUrl = JSON.stringify(url);
  const cmd = `yt-dlp --dump-json --no-playlist --no-check-certificates ${safeUrl}`;

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
    cmd = `yt-dlp -x --audio-format mp3 --audio-quality ${quality}k --newline --no-check-certificates -o ${safeOut} ${safeUrl}`;
  } else {
    const safeFmt = JSON.stringify(`${format_id}+bestaudio[ext=m4a]/best[ext=mp4]/best`);
    cmd = `yt-dlp -f ${safeFmt} --merge-output-format mp4 --newline --no-check-certificates -o ${safeOut} ${safeUrl}`;
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

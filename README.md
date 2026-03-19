# StreamGrab 🎬

محمّل فيديو احترافي مبني على **yt-dlp + Node.js + Express**  
تطوير: **Ahmed Morgan** 🥰

## المتطلبات

* Node.js 18+
* Python 3.8+
* ffmpeg

## التثبيت

```bash
# 1. تثبيت yt-dlp
pip install yt-dlp

# 2. تثبيت ffmpeg
# Windows:
winget install ffmpeg
# Mac:
brew install ffmpeg
# Linux:
sudo apt install ffmpeg

# 3. تثبيت dependencies
npm install

# 4. تشغيل السيرفر
npm start
```

افتح المتصفح على: **http://localhost:3000**

## الـ API Endpoints

| Method | Endpoint | الوصف |
|--------|----------|-------|
| GET | `/info?url=...` | معلومات الفيديو + الصيغ المتاحة |
| GET | `/download-progress?url=...&format_id=...&type=...` | تحميل بـ SSE progress |
| GET | `/get-file?file=...&filename=...` | تنزيل الملف بعد المعالجة |
| GET | `/health` | حالة السيرفر |

## المنصات المدعومة

YouTube · TikTok · Instagram · **Threads** · Facebook · Twitter/X · Vimeo · Twitch · Dailymotion · SoundCloud · Reddit · وأكثر من ١٠٠٠ موقع

## مميزات الإصدار 2.0.0

- ✅ **دعم Threads** (threads.net)
- 🔒 **حماية من Command Injection** — URL sanitization كامل
- 🔒 **حماية من Path Traversal** — التحقق من مسارات الملفات
- 🚦 **Rate Limiting** — 20 req/min للتحليل، 5 req/min للتحميل
- 💾 **السجل محفوظ** في localStorage بين الجلسات
- ⚙️ **الإعدادات تتطبق فعلياً** على التحميل
- 🌐 **Domain Whitelist** — قائمة بيضاء بالمواقع المسموحة

## Deploy على Railway

```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/USERNAME/streamgrab.git
git push -u origin main
# → railway.app → New Project → Deploy from GitHub
```

## هيكل المشروع

```
streamgrab/
├── server.js          ← API الرئيسي (مع كل إجراءات الأمان)
├── package.json
├── Dockerfile
├── .gitignore
├── README.md
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## ملاحظات مهمة

* yt-dlp بيتحدث باستمرار — نفّذ `pip install -U yt-dlp` أسبوعياً
* الملفات تُحذف تلقائياً بعد 5 دقائق من اكتمال التحميل
* بعض المواقع (Netflix, Disney+) محمية بـ DRM ولا يمكن تحميلها
* استخدم الأداة بشكل قانوني فقط

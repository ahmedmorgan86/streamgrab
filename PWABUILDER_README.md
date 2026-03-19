# StreamGrab — PWABuilder Package
تطوير: Ahmed Morgan

## كيفية الاستخدام مع PWABuilder

### الخطوة 1 — Deploy التطبيق
ارفع المشروع على Railway أو Vercel أو أي hosting
```bash
# Railway
railway up
```

### الخطوة 2 — PWABuilder
1. افتح https://www.pwabuilder.com
2. أدخل رابط التطبيق المنشور
3. هيفحص الـ manifest.json و service-worker.js تلقائياً
4. اختار "Package for stores"
5. اختار Google Play / Microsoft Store / Apple App Store

### الملفات المهمة

| الملف | الوصف |
|-------|-------|
| `public/manifest.json`      | Web App Manifest كامل مع كل الأيقونات |
| `public/service-worker.js`  | Service Worker v2 مع Cache + Offline support |
| `public/icons/icon-512.png` | الأيقونة الرئيسية (مطلوبة لـ PWABuilder) |
| `public/icons/icon-192.png` | أيقونة maskable |

### متطلبات PWABuilder
- ✅ HTTPS على الدومين
- ✅ manifest.json مكتمل
- ✅ service-worker.js مسجّل
- ✅ أيقونة 512×512
- ✅ أيقونة maskable

### ألوان التطبيق
- Theme Color:      `#00e5ff`
- Background Color: `#080810`

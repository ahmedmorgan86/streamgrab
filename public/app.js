const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3000' : '';

let currentUrl     = '';
let currentFormats = [];
let evtSource      = null;
let dlHistory      = [];

// ── Page Navigation ────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
  const page = document.getElementById('page-' + name);
  if (page) {
    page.classList.add('on');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.querySelectorAll('.nav-a, .drawer-item').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.page === name);
  });
  if (name === 'history')  renderHistory();
  if (name === 'settings') loadSettings();
}

// ── Mobile Menu ────────────────────────────────────────────────────────────
function toggleMenu() {
  const drawer  = document.getElementById('drawer');
  const overlay = document.getElementById('overlay');
  const burger  = document.getElementById('burgerBtn');
  const isOpen  = drawer.classList.contains('open');
  drawer.classList.toggle('open', !isOpen);
  overlay.classList.toggle('show', !isOpen);
  burger.classList.toggle('open', !isOpen);
}
function closeMenu() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('burgerBtn').classList.remove('open');
}

// ── Analyze URL ────────────────────────────────────────────────────────────
async function analyze() {
  const url = document.getElementById('urlIn').value.trim();
  if (!url) { document.getElementById('urlIn').focus(); return; }

  currentUrl = url;
  setLoading(true, 'جاري تحليل الرابط...');
  hideResults();

  try {
    const res  = await fetch(`${API}/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentFormats = data.formats;
    renderVideoMeta(data);

    // طبّق الإعداد المحفوظ للتبويب الافتراضي
    const prefTab = localStorage.getItem('sg_prefTab') || 'video';
    const tabBtns = document.querySelectorAll('.tab');
    tabBtns.forEach(b => b.classList.remove('on'));
    const activeTab = [...tabBtns].find(b => b.dataset.type === prefTab);
    if (activeTab) activeTab.classList.add('on');
    renderFormats(prefTab);

    showResults();
  } catch (err) {
    showError('فشل تحليل الرابط: ' + err.message);
  } finally {
    setLoading(false);
  }
}

// ── Render video info ──────────────────────────────────────────────────────
function renderVideoMeta(data) {
  document.getElementById('vtitle').textContent    = data.title    || 'بدون عنوان';
  document.getElementById('vuploader').textContent = data.uploader || '—';
  document.getElementById('vviews').textContent    = data.view_count
    ? Number(data.view_count).toLocaleString('ar-EG') + ' مشاهدة' : '—';
  document.getElementById('vduration').textContent = data.duration
    ? formatDuration(data.duration) : '—';

  const thumb = document.getElementById('vthumb');
  if (data.thumbnail) { thumb.src = data.thumbnail; thumb.style.display = 'block'; }

  const badges  = document.getElementById('qbadges');
  badges.innerHTML = '';
  const heights = [...new Set(
    currentFormats.filter(f => f.height).map(f => f.height)
  )].sort((a, b) => b - a).slice(0, 5);

  for (const h of heights) {
    const sp = document.createElement('span');
    sp.className = h >= 2160 ? 'qb k4' : h >= 720 ? 'qb hd' : 'qb sd';
    sp.textContent = h >= 2160 ? '4K' : h + 'p';
    badges.appendChild(sp);
  }
}

// ── Render Formats ─────────────────────────────────────────────────────────
function renderFormats(type) {
  const grid = document.getElementById('fmtGrid');
  grid.innerHTML = '';

  if (type === 'video') {
    // اقرأ الإعدادات المحفوظة
    const prefQuality = localStorage.getItem('sg_prefQuality') || 'best';
    const prefFormat  = localStorage.getItem('sg_prefFormat')  || 'mp4';

    const vids = currentFormats
      .filter(f => f.type === 'video' && f.height)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const seen = new Set();
    let unique = vids.filter(f => {
      const k = `${f.height}_${f.ext}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });

    // فلتر حسب الجودة المفضلة
    if (prefQuality !== 'best' && unique.length > 0) {
      const targetH = parseInt(prefQuality, 10);
      const closest = unique.reduce((prev, cur) =>
        Math.abs(cur.height - targetH) < Math.abs(prev.height - targetH) ? cur : prev
      );
      unique = [closest, ...unique.filter(f => f !== closest)];
    }

    unique.forEach((f, i) => {
      const label = f.height >= 2160 ? '4K Ultra HD'
        : f.height >= 1080 ? `${f.height}p Full HD`
        : f.height >= 720  ? `${f.height}p HD`
        : `${f.height}p`;

      const size        = f.filesize ? formatSize(f.filesize) : '—';
      const best        = i === 0;
      const codec       = escHtmlStr([f.vcodec ? f.vcodec.split('.')[0] : '', f.fps ? f.fps + 'fps' : '', f.ext?.toUpperCase()].filter(Boolean).join(' · '));
      const resolution  = escHtmlStr(f.resolution || f.height + 'p');
      const safeSize    = escHtmlStr(size);
      const isPreferred = prefFormat !== 'mp4' && f.ext === prefFormat;

      // format_id جاهز من السيرفر (cached ID للـ Threads)
      const dlFormatId = f.format_id;
      grid.insertAdjacentHTML('beforeend', `
        <div class="frow ${best ? 'best' : ''}" onclick="startDownload('${dlFormatId}','video','${escHtml(f.ext)}','${escHtml(label)}')">
          <div>
            <div class="fn">
              ${best ? '<span class="best-chip">الأفضل</span>' : ''}
              ${isPreferred ? '<span class="best-chip" style="background:#7c3aed">مفضل</span>' : ''}
              ${escHtmlStr(label)}
            </div>
            <div class="fc">${codec}</div>
          </div>
          <div class="fres">${resolution}</div>
          <div class="fsz">${safeSize}</div>
          <button class="dlbtn" title="تحميل" onclick="event.stopPropagation();startDownload('${escHtml(dlFormatId)}','video','${escHtml(f.ext)}','${escHtml(label)}')">
            ${dlIcon()}
          </button>
        </div>`);
    });

  } else {
    // اقرأ جودة الصوت المفضلة
    const prefAudio = localStorage.getItem('sg_prefAudio') || '320';

    const presets = [
      { label: 'MP3 — ٣٢٠ كيلوبت/ث', bitrate: '320', codec: 'أعلى جودة صوت · متوافق مع جميع الأجهزة' },
      { label: 'MP3 — ٢٥٦ كيلوبت/ث', bitrate: '256', codec: 'جودة عالية جداً' },
      { label: 'MP3 — ١٩٢ كيلوبت/ث', bitrate: '192', codec: 'جودة جيدة وحجم معقول' },
      { label: 'MP3 — ١٢٨ كيلوبت/ث', bitrate: '128', codec: 'حجم صغير مناسب للهواتف' },
    ];

    for (const p of presets) {
      const best = p.bitrate === prefAudio;
      grid.insertAdjacentHTML('beforeend', `
        <div class="frow ${best ? 'best' : ''}" onclick="startDownload('${p.bitrate}','audio','mp3','${escHtml(p.label)}')">
          <div>
            <div class="fn">${best ? '<span class="best-chip">مفضل</span>' : ''}${escHtmlStr(p.label)}</div>
            <div class="fc">${escHtmlStr(p.codec)}</div>
          </div>
          <div class="fres">${p.bitrate} kbps</div>
          <div class="fsz">—</div>
          <button class="dlbtn" title="تحميل" onclick="event.stopPropagation();startDownload('${p.bitrate}','audio','mp3','${escHtml(p.label)}')">
            ${dlIcon()}
          </button>
        </div>`);
    }
  }
}

// ── Download with SSE Progress ─────────────────────────────────────────────
function startDownload(formatId, type, ext, label) {
  if (evtSource) { evtSource.close(); evtSource = null; }

  const prog  = document.getElementById('dlProg');
  const fill  = document.getElementById('dpFill');
  const lbl   = document.getElementById('dpLbl');
  const pct   = document.getElementById('dpPct');
  const speed = document.getElementById('dpSpeed');
  const eta   = document.getElementById('dpEta');
  const done  = document.getElementById('dpDone');

  prog.classList.add('on');
  done.classList.remove('on');
  fill.style.width      = '0%';
  fill.style.background = '';
  pct.textContent       = '0%';
  lbl.textContent       = 'جاري التحضير...';
  if (speed) speed.textContent = '';
  if (eta)   eta.textContent   = '';

  prog.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const params = new URLSearchParams({ url: currentUrl, format_id: formatId, filename: label, type });
  evtSource = new EventSource(`${API}/download-progress?${params}`);

  evtSource.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.status === 'downloading') {
      fill.style.width = msg.percent + '%';
      pct.textContent  = msg.percent + '%';
      lbl.textContent  = `جاري التحميل: ${label}`;
      if (speed && msg.speed) speed.textContent = msg.speed;
      if (eta   && msg.eta)   eta.textContent   = 'الوقت المتبقي: ' + msg.eta;
    }

    if (msg.status === 'done') {
      fill.style.width = '100%';
      pct.textContent  = '100%';
      done.classList.add('on');
      evtSource.close(); evtSource = null;

      addToHistory({
        title: document.getElementById('vtitle').textContent,
        label,
        thumb: document.getElementById('vthumb').src,
        url:   currentUrl,
        time:  new Date().toISOString(),
      });

      window.location.href = `${API}/get-file?${new URLSearchParams({ file: msg.file, filename: msg.filename })}`;
    }

    if (msg.status === 'error') {
      lbl.textContent       = '❌ ' + msg.message;
      fill.style.background = 'var(--red)';
      evtSource.close(); evtSource = null;
    }
  };

  evtSource.onerror = () => {
    lbl.textContent = '❌ انقطع الاتصال بالسيرفر';
    evtSource.close(); evtSource = null;
  };
}

// ── Tab switch ─────────────────────────────────────────────────────────────
function switchTab(type, btn) {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  renderFormats(type);
  document.getElementById('dlProg').classList.remove('on');
  // احفظ التبويب المختار في الإعدادات
  try { localStorage.setItem('sg_prefTab', type); } catch {}
}

// ── History — محفوظ في localStorage ───────────────────────────────────────
function loadHistory() {
  try {
    const raw = localStorage.getItem('sg_history');
    dlHistory = raw ? JSON.parse(raw) : [];
  } catch { dlHistory = []; }
}

function saveHistory() {
  try { localStorage.setItem('sg_history', JSON.stringify(dlHistory)); } catch {}
}

function addToHistory(item) {
  dlHistory.unshift(item);
  if (dlHistory.length > 50) dlHistory.pop();
  saveHistory();
}

function renderHistory() {
  const empty = document.getElementById('historyEmpty');
  const list  = document.getElementById('historyList');

  if (dlHistory.length === 0) {
    empty.style.display = 'block';
    list.style.display  = 'none';
    return;
  }

  empty.style.display = 'none';
  list.style.display  = 'flex';
  list.innerHTML = dlHistory.map((h, i) => `
    <div class="history-row">
      ${h.thumb ? `<img class="history-thumb" src="${h.thumb}" alt="">` : '<div class="history-thumb"></div>'}
      <div class="history-info">
        <div class="history-title">${escHtmlStr(h.title)}</div>
        <div class="history-meta">${escHtmlStr(h.label)} · ${formatTimeAgo(h.time)}</div>
      </div>
      <span class="history-badge">مكتمل ✓</span>
    </div>`).join('');
}

function clearHistory() {
  dlHistory = [];
  saveHistory();
  renderHistory();
  showToast('تم مسح السجل بنجاح');
}

function formatTimeAgo(date) {
  const diff = Math.round((Date.now() - new Date(date)) / 1000);
  if (diff < 60)    return 'منذ لحظات';
  if (diff < 3600)  return `منذ ${Math.round(diff / 60)} دقيقة`;
  if (diff < 86400) return `منذ ${Math.round(diff / 3600)} ساعة`;
  return `منذ ${Math.round(diff / 86400)} يوم`;
}

// ── Settings ───────────────────────────────────────────────────────────────
function saveSetting(key, value) {
  try { localStorage.setItem('sg_' + key, value); } catch {}
  showToast('تم حفظ الإعداد');
}

function loadSettings() {
  try {
    const q = localStorage.getItem('sg_prefQuality');
    const f = localStorage.getItem('sg_prefFormat');
    const a = localStorage.getItem('sg_prefAudio');
    const c = localStorage.getItem('sg_autoClear');
    if (q) document.getElementById('prefQuality').value = q;
    if (f) document.getElementById('prefFormat').value  = f;
    if (a) document.getElementById('prefAudio').value   = a;
    if (c !== null) document.getElementById('autoClear').checked = c === 'true';
  } catch {}
}

function resetSettings() {
  try {
    ['prefQuality','prefFormat','prefAudio','autoClear'].forEach(k => localStorage.removeItem('sg_' + k));
  } catch {}
  loadSettings();
  showToast('تمت إعادة ضبط الإعدادات');
}

// ── FAQ Toggle ─────────────────────────────────────────────────────────────
function toggleFaq(btn) {
  const answer = btn.nextElementSibling;
  const isOpen = answer.classList.contains('open');
  document.querySelectorAll('.faq-a').forEach(a => a.classList.remove('open'));
  document.querySelectorAll('.faq-q').forEach(q => q.classList.remove('open'));
  if (!isOpen) { answer.classList.add('open'); btn.classList.add('open'); }
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  let toast = document.getElementById('sg-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sg-toast';
    toast.style.cssText = `
      position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);
      background:#1c1c2e;border:1px solid rgba(0,229,255,.2);border-radius:12px;
      padding:12px 24px;font-size:13px;font-weight:500;color:#00e5ff;
      z-index:9999;transition:transform .35s cubic-bezier(.34,1.56,.64,1);
      white-space:nowrap;box-shadow:0 8px 32px rgba(0,0,0,.4);`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.transform = 'translateX(-50%) translateY(80px)'; }, 2800);
}

// ── UI Helpers ─────────────────────────────────────────────────────────────
function setLoading(on, msg = '') {
  const lw = document.getElementById('loadWrap');
  const lf = document.getElementById('loadFill');
  const lt = document.getElementById('loadTxt');
  lw.classList.toggle('on', on);
  lt.textContent = msg;
  lt.style.color = '';
  if (on) {
    lf.style.width = '0%';
    let p = 0;
    clearInterval(window._loadT);
    window._loadT = setInterval(() => {
      p += Math.random() * 4 + 1;
      lf.style.width = Math.min(p, 88) + '%';
      if (p > 40) lt.textContent = 'جاري استخراج معلومات الفيديو...';
      if (p > 70) lt.textContent = 'جاري تحضير خيارات التحميل...';
    }, 80);
  } else {
    clearInterval(window._loadT);
    lf.style.width = '100%';
    setTimeout(() => lw.classList.remove('on'), 400);
  }
}

function showResults() {
  document.getElementById('results').classList.add('on');
  document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function hideResults() {
  document.getElementById('results').classList.remove('on');
}
function showError(msg) {
  const lt = document.getElementById('loadTxt');
  lt.textContent = '❌ ' + msg;
  lt.style.color = 'var(--red)';
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes > 1e6) return Math.round(bytes / 1e6) + ' MB';
  return Math.round(bytes / 1e3) + ' KB';
}

function escHtml(str) {
  return String(str || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

function escHtmlStr(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function dlIcon() {
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M7 2v8M4 7l3 4 3-4M2 12h10" stroke="#f0f0fa" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function countUp(el, target, suffix, dur) {
  if (!el) return;
  const start = Date.now();
  const step  = () => {
    const p = Math.min((Date.now() - start) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(e * target) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // حقوق الملكية
  const year   = new Date().getFullYear();
  const footer = document.getElementById('footerCopy');
  if (footer) footer.textContent = `© ${year} StreamGrab · تطوير Ahmed Morgan · للاستخدام الشخصي القانوني فقط`;

  // تحميل السجل المحفوظ
  loadHistory();

  // مسح السجل عند الإغلاق لو الإعداد مفعّل
  window.addEventListener('beforeunload', () => {
    try {
      const autoClear = localStorage.getItem('sg_autoClear');
      if (autoClear === 'true') {
        dlHistory = [];
        localStorage.removeItem('sg_history');
      }
    } catch {}
  });

  // Enter في خانة الرابط
  document.getElementById('urlIn').addEventListener('keydown', e => {
    if (e.key === 'Enter') analyze();
  });

  // Escape يغلق الـ drawer
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
  });
});

// popup.js — BehaviorLens v4

const CAT_COLOR = {
  'Search':     'var(--c-search)',
  'Site Visit': 'var(--c-site)',
  'Ad':         'var(--c-ad)',
  'Video':      'var(--c-video)',
  'Product':    'var(--c-product)',
  'Article':    'var(--c-article)',
  'Purchase':   'var(--c-purchase)',
};

const EVENT_TYPE_LABEL = {
  'search':        'Search',
  'page_visit':    'Visit',
  'video_play':    'Play',
  'video_pause':   'Pause',
  'video_complete':'Watched',
  'video_seek':    'Seek',
  'product_view':  'Product',
  'article_read':  'Article',
  'ad_click':      'Ad',
  'purchase':      'Purchase',
};

// ── Auto-download state ────────────────────────────────────────────────────
// stepIndex 0 = off, 1 = 1 min, 2 = 5 min, 3 = 10 min
const AUTO_STEPS = [
  { label: '↓ Auto', minutes: 0 },
  { label: '↓ 1 min', minutes: 1 },
  { label: '↓ 5 min', minutes: 5 },
  { label: '↓ 10 min', minutes: 10 },
];

let stepIndex     = 0;
let countdownTick = null;

// ── DOM refs ──────────────────────────────────────────────────────────────
let allLogs        = [];
let currentEnabled = true;

const feed           = document.getElementById('feed');
const emptyEl        = document.getElementById('emptyEl');
const toggleBtn      = document.getElementById('toggleBtn');
const recLabel       = document.getElementById('recLabel');
const recDot         = document.getElementById('recDot');
const totalN         = document.getElementById('totalN');
const autoBtn        = document.getElementById('autoBtn');
const autoCountdown  = document.getElementById('autoCountdown');
const countdownFill  = document.getElementById('countdownFill');
const countdownLabel = document.getElementById('countdownLabel');

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
  catch { return '--'; }
}

function fmtCountdown(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function propsPreview(log) {
  const ep = log.event_properties || {};
  switch (log.event_type) {
    case 'search':
      return ep.search_query ? ep.search_query : null;
    case 'page_visit':
      return ep.page_title || null;
    case 'video_play':
    case 'video_pause':
    case 'video_complete':
      return [ep.video_title,
              ep.watch_time_sec != null ? `${ep.watch_time_sec}s watched` : null
             ].filter(Boolean).join('  ·  ');
    case 'product_view':
      return [ep.product_name, ep.price].filter(Boolean).join('  ·  ');
    case 'article_read':
      return [ep.article_title,
              ep.estimated_read_min ? `~${ep.estimated_read_min} min read` : null
             ].filter(Boolean).join('  ·  ');
    case 'ad_click':
      return ep.ad_text || null;
    case 'purchase':
      return [ep.order_id ? `Order #${ep.order_id}` : null, ep.order_total].filter(Boolean).join('  ·  ');
    default: return null;
  }
}

// ── Render feed ───────────────────────────────────────────────────────────
function render() {
  feed.querySelectorAll('.row').forEach(e => e.remove());

  if (allLogs.length === 0) {
    emptyEl.style.display = 'flex';
    totalN.textContent = '0';
    return;
  }

  emptyEl.style.display = 'none';
  const frag = document.createDocumentFragment();

  allLogs.slice(0, 300).forEach(log => {
    const color   = CAT_COLOR[log._ui?.category] || 'var(--border)';
    const preview = propsPreview(log);
    const badge   = EVENT_TYPE_LABEL[log.event_type] || log.event_type;
    const div = document.createElement('div');
    div.className = 'row';
    div.style.setProperty('--rc', color);
    div.title = log.url || '';
    div.innerHTML = `
      <div class="row-icon">${log._ui?.icon || '📌'}</div>
      <div class="row-body">
        <div class="row-top">
          <span class="row-label">${esc(log._ui?.site || log.domain || log.event_type)}</span>
          <span class="row-badge">${esc(badge)}</span>
          <span class="row-time">${fmtTime(log.timestamp_local)}</span>
        </div>
        ${preview ? `<div class="row-detail">${esc(preview)}</div>` : ''}
        <div class="row-meta">
          ${log.domain ? `<span class="domain">${esc(log.domain)}</span>` : ''}
          ${log.dwell_time_sec != null ? `<span>⏱ ${log.dwell_time_sec}s</span>` : ''}
          ${log.engagement?.scroll_depth_pct != null ? `<span>↕ ${log.engagement.scroll_depth_pct}%</span>` : ''}
        </div>
      </div>`;
    frag.appendChild(div);
  });

  feed.insertBefore(frag, emptyEl);
  totalN.textContent = allLogs.length;
}

function loadFromBg() {
  chrome.runtime.sendMessage({ type: 'get_logs' }, res => {
    if (chrome.runtime.lastError || !res) return;
    allLogs = res.logs || [];
    updateRecUI(res.enabled);
    render();
  });
}

function updateRecUI(enabled) {
  currentEnabled = enabled;
  if (enabled) {
    toggleBtn.className = 'btn btn-toggle live';
    recLabel.textContent = '● Live';
    recDot.className = 'brand-dot';
  } else {
    toggleBtn.className = 'btn btn-toggle';
    recLabel.textContent = '○ Paused';
    recDot.className = 'brand-dot off';
  }
}

// ── Export helper — routed through background so chrome.downloads overwrite works ──
function doExport() {
  if (allLogs.length === 0) { alert('No logs to export yet.'); return; }
  chrome.runtime.sendMessage({ type: 'export_logs' }, res => {
    if (chrome.runtime.lastError || !res) return;
    if (res.empty) { alert('No logs to export yet.'); return; }
    // Background cleared logs after download — sync popup state.
    allLogs = [];
    render();
  });
}

// ── Auto-download: countdown UI (reads alarm scheduledTime from background) ──
function startCountdownUI(scheduledTime) {
  clearInterval(countdownTick);

  function tick() {
    const remaining = Math.max(0, Math.round((scheduledTime - Date.now()) / 1000));
    const total     = AUTO_STEPS[stepIndex].minutes * 60;
    const pct       = total > 0 ? remaining / total : 0;
    countdownFill.style.transform  = `scaleX(${pct})`;
    countdownLabel.textContent     = fmtCountdown(remaining);
    if (remaining === 0) clearInterval(countdownTick);
  }

  tick();
  countdownTick = setInterval(tick, 1000);
}

function stopCountdownUI() {
  clearInterval(countdownTick);
  countdownTick = null;
  countdownFill.style.transform = 'scaleX(1)';
  countdownLabel.textContent    = fmtCountdown(AUTO_STEPS[stepIndex].minutes * 60);
}

// ── Auto-download: update button visuals ──────────────────────────────────
function updateAutoUI(scheduledTime) {
  autoBtn.textContent = AUTO_STEPS[stepIndex].label;
  if (stepIndex === 0) {
    autoBtn.classList.remove('active');
    autoCountdown.classList.add('hidden');
    stopCountdownUI();
  } else {
    autoBtn.classList.add('active');
    autoCountdown.classList.remove('hidden');
    if (scheduledTime) startCountdownUI(scheduledTime);
  }
}

// ── Auto-download: cycle button — tells background to set/clear the alarm ─
autoBtn.addEventListener('click', () => {
  stepIndex = (stepIndex + 1) % AUTO_STEPS.length;
  // Optimistically update UI, then confirm with background
  updateAutoUI(null);
  chrome.runtime.sendMessage({ type: 'set_auto_step', stepIndex }, () => {
    // Re-fetch alarm time so countdown starts from the real scheduledTime
    syncAutoState();
  });
});

// ── Sync alarm state from background into popup UI ────────────────────────
function syncAutoState() {
  chrome.runtime.sendMessage({ type: 'get_auto_alarm' }, res => {
    if (chrome.runtime.lastError || !res) return;
    stepIndex = res.stepIndex ?? 0;
    updateAutoUI(res.scheduledTime);
  });
}

// ── Existing button wiring ─────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  currentEnabled = !currentEnabled;
  chrome.runtime.sendMessage({ type: 'set_enabled', value: currentEnabled }, () => updateRecUI(currentEnabled));
});

document.getElementById('clearBtn').addEventListener('click', () => {
  if (!confirm('Clear all session logs? Export first if needed.')) return;
  chrome.runtime.sendMessage({ type: 'clear_logs' }, () => {
    allLogs = [];
    render();
  });
});

document.getElementById('exportBtn').addEventListener('click', doExport);

// ── Init ──────────────────────────────────────────────────────────────────
syncAutoState();
setInterval(loadFromBg, 2500);
loadFromBg();

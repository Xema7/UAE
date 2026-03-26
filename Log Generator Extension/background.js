// background.js — BehaviorLens v4
// Emits structured analytics events matching the defined schema.

const SCHEMA_VERSION = "1.0";
const MAX_LOGS = 5000;

// ── Identity — generated once per install, persisted in storage ──────────────
let USER_ID    = null;
let DEVICE_ID  = null;
let SESSION_ID = null;
let seqNum     = 0;
let sessionLogs = [];
let loggingEnabled = true;
const SESSION_START_TS = Date.now();

// FIX (Bug #1 + #2): Single init path with a ready-queue so no event ever
// gets null IDs. Replaces the two separate/racing init blocks.
let _ready = false;
const _queue = [];

// ── Log persistence constants (declared early — used by initIds below) ────────
const STORAGE_KEY_LOGS     = 'bl_session_logs';
const STORAGE_KEY_EXPORTED = 'bl_exported_logs'; // all-time cumulative log

async function initIds() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['user_id', 'device_id', STORAGE_KEY_LOGS]),
    chrome.storage.session.get(['bl_enabled']),
  ]);

  USER_ID   = local.user_id   || uuid();
  DEVICE_ID = local.device_id || uuid();
  SESSION_ID = uuid();
  await chrome.storage.local.set({ user_id: USER_ID, device_id: DEVICE_ID });

  // Restore enabled state from chrome.storage.session.
  // This storage area is automatically wiped on full browser restart, so
  // loggingEnabled always resets to true on a fresh browser open.
  // SW idle-restarts within the same session preserve it correctly.
  if (typeof session.bl_enabled === 'boolean') {
    loggingEnabled = session.bl_enabled;
  }

  // Rehydrate persisted logs — survive browser close/restart.
  const raw = local[STORAGE_KEY_LOGS];
  if (Array.isArray(raw) && raw.length > 0) {
    sessionLogs = raw.map(e => (typeof e === 'string' ? JSON.parse(e) : e));
    seqNum = sessionLogs.reduce((max, e) => Math.max(max, e.sequence_number || 0), 0);
  }

  _ready = true;
  _queue.forEach(evt => _commitLog(evt));
  _queue.length = 0;
  console.log('[BehaviorLens] Ready. user_id:', USER_ID, '| rehydrated logs:', sessionLogs.length);
}

// Page-level dwell tracking: tabId → { url, startTs, scrollDepth, clickCount, eventId }
const dwellMap = new Map();

// ── UUID ──────────────────────────────────────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── URL cleaner — keeps meaningful params, strips all trackers ───────────────
const KEEP_PARAMS = new Set([
  'q', 'query', 'search_query', 'keyword', 'k', 'field-keywords',
  'v', 't', 'list', 'index',
  'tbm', 'num', 'start',
  'page', 'p', 'sort', 'order', 'category', 'brand', 'color', 'size',
  'th', 'psc',
]);

const TRACKER_PATTERNS = [
  /^utm_/, /^ref/, /^_encoding/, /^pd_rd/, /^pf_rd/, /^content-id/,
  /^s$/, /^sprefix/, /^crid/, /^qid/, /^rnid/, /^linkCode/, /^tag/,
  /^linkId/, /^camp/, /^creative/, /^adid/, /^adgrpid/, /^campaignid/,
  /^gclid/, /^fbclid/, /^msclkid/, /^twclid/, /^ttclid/, /^dclid/,
  /^mc_/, /^yclid/, /^igshid/, /^epik/, /^srsltid/, /^ved/, /^ei/,
  /^sa$/, /^usg/, /^oq/, /^gs_/,
];

function isTrackerParam(key) {
  return TRACKER_PATTERNS.some(rx => rx.test(key));
}

function cleanUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    const cleaned = new URLSearchParams();
    for (const [key, val] of u.searchParams.entries()) {
      if (KEEP_PARAMS.has(key) && !isTrackerParam(key)) {
        cleaned.append(key, val);
      }
    }
    const qs = cleaned.toString();
    return u.origin + u.pathname + (qs ? '?' + qs : '');
  } catch {
    return rawUrl;
  }
}

// ── Site / content-category classifier ───────────────────────────────────────
const SITE_MAP = [
  { key: 'google',     label: 'Google',      pattern: /google\.[a-z.]+/,        icon: '🔵', category: 'search_engine' },
  { key: 'youtube',    label: 'YouTube',     pattern: /youtube\.com|youtu\.be/, icon: '🔴', category: 'video' },
  { key: 'amazon',     label: 'Amazon',      pattern: /amazon\.[a-z.]+/,        icon: '🟠', category: 'ecommerce' },
  { key: 'flipkart',   label: 'Flipkart',    pattern: /flipkart\.com/,           icon: '🟡', category: 'ecommerce' },
  { key: 'myntra',     label: 'Myntra',      pattern: /myntra\.com/,             icon: '🛍️', category: 'ecommerce' },
  { key: 'meesho',     label: 'Meesho',      pattern: /meesho\.com/,             icon: '🛒', category: 'ecommerce' },
  { key: 'snapdeal',   label: 'Snapdeal',    pattern: /snapdeal\.com/,           icon: '🏪', category: 'ecommerce' },
  { key: 'nykaa',      label: 'Nykaa',       pattern: /nykaa\.com/,              icon: '💄', category: 'ecommerce' },
  { key: 'ajio',       label: 'Ajio',        pattern: /ajio\.com/,               icon: '👗', category: 'ecommerce' },
  { key: 'tatacliq',   label: 'TataCliq',    pattern: /tatacliq\.com/,           icon: '🏷️', category: 'ecommerce' },
  { key: 'instagram',  label: 'Instagram',   pattern: /instagram\.com/,          icon: '🟣', category: 'social_media' },
  { key: 'facebook',   label: 'Facebook',    pattern: /facebook\.com/,           icon: '🔷', category: 'social_media' },
  { key: 'twitter',    label: 'Twitter/X',   pattern: /twitter\.com|x\.com/,     icon: '⬛', category: 'social_media' },
  { key: 'reddit',     label: 'Reddit',      pattern: /reddit\.com/,             icon: '🟥', category: 'social_media' },
  { key: 'netflix',    label: 'Netflix',     pattern: /netflix\.com/,            icon: '🎬', category: 'video' },
  { key: 'hotstar',    label: 'Hotstar',     pattern: /hotstar\.com|disneyplus/, icon: '⭐', category: 'video' },
  { key: 'primevideo', label: 'Prime Video', pattern: /primevideo\.com/,         icon: '🎥', category: 'video' },
  { key: 'wikipedia',  label: 'Wikipedia',   pattern: /wikipedia\.org/,          icon: '📖', category: 'reference' },
];

function classifySite(url) {
  if (!url) return null;
  for (const s of SITE_MAP) {
    if (s.pattern.test(url)) return s;
  }
  try {
    const host = new URL(url).hostname.replace('www.', '');
    return { key: 'other', label: host, icon: '🌐', category: 'general' };
  } catch { return null; }
}

// FIX (Refactor #3): Use chrome.runtime.getPlatformInfo() for reliable OS;
// hard-code 'chrome' for browser since MV3 only runs on Chromium.
let _platformOs = 'unknown';
chrome.runtime.getPlatformInfo().then(info => { _platformOs = info.os; }).catch(() => {});

// ── Core event builder ────────────────────────────────────────────────────────
function buildEvent(eventType, tab, overrides = {}) {
  seqNum++;
  const url = cleanUrl(tab?.url || overrides.url || null);
  let domain = null;
  try { domain = url ? new URL(url).hostname : null; } catch (_) {}

  return {
    schema_version:  SCHEMA_VERSION,
    event_id:        uuid(),
    user_id:         USER_ID,
    device_id:       DEVICE_ID,
    session_id:      SESSION_ID,
    sequence_number: seqNum,
    event_type:      eventType,
    timestamp_local:   new Date().toLocaleString(),
    browser:         'chrome',
    os:              _platformOs,
    domain,
    url,
    referrer:        null,
    dwell_time_sec:  null,
    engagement: {
      scroll_depth_pct: null,
      click_count:      null,
    },
    event_properties: {},
    _ui: {
      icon:     overrides._icon  || '📌',
      label:    overrides._label || eventType,
      detail:   overrides._detail || '',
      category: overrides._category || eventType,
      site:     overrides._site || domain,
    },
    // Spread any extra fields from _merge onto root (e.g. referrer, event_properties)
    ...(overrides._merge || {}),
  };
}

// ── Log persistence ───────────────────────────────────────────────────────────
// Write to storage on every commit. chrome.storage.local writes are async and
// internally coalesced by Chrome — reliable across browser close, crashes, and
// service worker idle-eviction. onSuspend is NOT used: it doesn't fire reliably
// on full browser exit in MV3, which was causing the blank-on-reopen bug.

function persistLogs() {
  // Serialise each event to a JSON string before storing so that key order is
  // frozen at write time. chrome.storage.local deserialises objects and returns
  // keys alphabetically, which would change the schema on rehydration.
  const serialised = sessionLogs.map(e => JSON.stringify(e));
  chrome.storage.local.set({ [STORAGE_KEY_LOGS]: serialised }).catch(() => {});
}

// FIX (Bug #1): Two-stage log commit — queue until IDs are ready.
function _commitLog(evt) {
  if (!loggingEnabled) return;
  sessionLogs.unshift(evt);
  if (sessionLogs.length > MAX_LOGS) sessionLogs.splice(MAX_LOGS);
  persistLogs();
}

function addLog(evt) {
  if (!loggingEnabled) return;
  if (!_ready) {
    _queue.push(evt);
    return;
  }
  _commitLog(evt);
}

// ── Tab events ────────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url || '';
  if (!url || url.startsWith('chrome://') || url.startsWith('about:')) return;

  const site = classifySite(url);
  if (!site) return;

  const cleanedUrl = cleanUrl(url);

  const evt = buildEvent('page_visit', tab, {
    _icon: site.icon, _label: `Visited ${site.label}`, _detail: tab.title || url,
    _category: 'Site Visit', _site: site.label,
    _merge: {
      event_properties: {
        content_category: site.category,
        page_title: tab.title || null,
        site_name:  site.label,
      }
    }
  });

  // FIX (Warning #2): Store event_id in dwellMap so back-fill matches by ID,
  // not by URL — prevents cross-tab URL collisions.
  dwellMap.set(tabId, {
    url: cleanedUrl,
    startTs: Date.now(),
    scrollDepth: null,
    clickCount: 0,
    eventId: evt.event_id,
  });

  addLog(evt);
});

// Tab closed → finalize dwell time
chrome.tabs.onRemoved.addListener((tabId) => {
  const dwell = dwellMap.get(tabId);
  if (dwell) {
    const secs = Math.round((Date.now() - dwell.startTs) / 1000);
    // FIX (Warning #2): Match by event_id instead of url
    const match = sessionLogs.find(l => l.event_id === dwell.eventId && l.dwell_time_sec === null);
    if (match) {
      match.dwell_time_sec = secs;
      match.engagement.scroll_depth_pct = dwell.scrollDepth;
      match.engagement.click_count      = dwell.clickCount;
      match._ui.detail = (match._ui.detail || '') + ` — ${secs}s dwell`;
    }
    dwellMap.delete(tabId);
  }
});

// Tab switched — finalize dwell on previous tab
chrome.tabs.onActivated.addListener(async (info) => {
  for (const [tabId, dwell] of dwellMap.entries()) {
    if (tabId !== info.tabId) {
      const secs = Math.round((Date.now() - dwell.startTs) / 1000);
      // FIX (Warning #2): Match by event_id
      const match = sessionLogs.find(l => l.event_id === dwell.eventId && l.dwell_time_sec === null);
      if (match && secs > 1) {
        match.dwell_time_sec = secs;
        match.engagement.scroll_depth_pct = dwell.scrollDepth;
        match.engagement.click_count      = dwell.clickCount;
      }
      dwellMap.delete(tabId);
    }
  }
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (tab.url && !tab.url.startsWith('chrome://')) {
      // Note: no eventId here since we're not creating a new page_visit event;
      // this just restarts the dwell timer for the already-logged visit.
      dwellMap.set(info.tabId, {
        url: tab.url,
        startTs: Date.now(),
        scrollDepth: null,
        clickCount: 0,
        eventId: null,
      });
    }
  } catch (_) {}
});

// ── Messages from content scripts ────────────────────────────────────────────
// FIX (Bug #6): Return true unconditionally so the message channel stays
// open for ALL branches that call sendResponse — not just get_logs.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'content_event') {
    const data  = msg.data || {};
    const tabId = sender.tab?.id;
    const url   = sender.tab?.url || null;

    if (tabId && dwellMap.has(tabId)) {
      const d = dwellMap.get(tabId);
      if (data.event_type === 'engagement_update') {
        if (data._scrollDepth != null) d.scrollDepth = data._scrollDepth;
        if (data._clickDelta)          d.clickCount  += data._clickDelta;
        return true;
      }
    }

    // engagement_update is internal bookkeeping only — never log it as an event.
    if (data.event_type === 'engagement_update') return true;

    const site = classifySite(url);
    const tab  = { url, title: sender.tab?.title };

    const evt = buildEvent(data.event_type, tab, {
      _icon:     data._icon,
      _label:    data._label,
      _detail:   data._detail,
      _category: data._category,
      _site:     data._site || site?.label,
      _merge: {
        referrer:         data.referrer || null,
        event_properties: data.event_properties || {},
      }
    });

    addLog(evt);
  }

  if (msg.type === 'get_logs') {
    sendResponse({ logs: sessionLogs, enabled: loggingEnabled, sessionStartTs: SESSION_START_TS });
    return true;
  }

  if (msg.type === 'set_enabled') {
    loggingEnabled = msg.value;
    // storage.session is wiped on browser restart — loggingEnabled always
    // resets to true (the default) when the browser is reopened.
    chrome.storage.session.set({ bl_enabled: msg.value });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'clear_logs') {
    sessionLogs = [];
    seqNum = 0;
    SESSION_ID = uuid();
    chrome.storage.local.remove([STORAGE_KEY_LOGS, STORAGE_KEY_EXPORTED]);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'export_logs') {
    triggerDownload(sendResponse);
    return true;
  }

  if (msg.type === 'set_auto_step') {
    applyAlarm(msg.stepIndex).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'get_auto_alarm') {
    chrome.alarms.get(AUTO_ALARM, alarm => {
      chrome.storage.local.get(['stepIndex'], stored => {
        sendResponse({
          stepIndex:     stored.stepIndex ?? 0,
          scheduledTime: alarm ? alarm.scheduledTime : null,
        });
      });
    });
    return true;
  }

  return true;
});

// ── Init ──────────────────────────────────────────────────────────────────────
// FIX (Bug #2): Single initIds() called from both hooks — no race, no duplicate writes.
chrome.runtime.onInstalled.addListener(() => initIds());
initIds(); // also runs on service worker restart (non-install)

// ── Auto-download (alarm-based) ───────────────────────────────────────────────
// stepIndex mirrors AUTO_STEPS in popup.js: 0=off, 1=1min, 2=5min, 3=10min
const AUTO_ALARM = 'bl_auto_download';
const AUTO_MINUTES = [0, 1, 5, 10];

function triggerDownload(sendResponse) {
  if (sessionLogs.length === 0) {
    if (sendResponse) sendResponse({ ok: false, empty: true });
    return;
  }
  // Load the cumulative exported log, merge current session on top, write file.
  chrome.storage.local.get([STORAGE_KEY_EXPORTED], stored => {
    const prevRaw  = stored[STORAGE_KEY_EXPORTED] || [];
    const prevLogs = prevRaw.map(e => (typeof e === 'string' ? JSON.parse(e) : e));

    // Merge: previous exports (oldest first) + current session (newest first → reverse)
    const combined = [...prevLogs, ...[...sessionLogs].reverse()];

    const ndjson  = combined
      .map(({ _ui, ...rest }) => JSON.stringify(rest))
      .join('\n');
    const b64     = btoa(unescape(encodeURIComponent(ndjson)));
    const dataUrl = 'data:application/x-ndjson;base64,' + b64;

    chrome.downloads.download({
      url:            dataUrl,
      filename:       'behaviorlens.ndjson',
      saveAs:         false,
      conflictAction: 'overwrite',
    }, () => {
      // Persist the full combined set as the new exported baseline.
      const combinedRaw = combined.map(e => JSON.stringify(e));
      chrome.storage.local.set({ [STORAGE_KEY_EXPORTED]: combinedRaw });
      // Clear the current session — it's now part of the exported log.
      sessionLogs = [];
      seqNum = 0;
      SESSION_ID = uuid();
      chrome.storage.local.remove(STORAGE_KEY_LOGS);
      if (sendResponse) sendResponse({ ok: true });
    });
  });
}

async function applyAlarm(stepIndex) {
  await chrome.alarms.clear(AUTO_ALARM);
  const minutes = AUTO_MINUTES[stepIndex] || 0;
  if (minutes > 0) {
    chrome.alarms.create(AUTO_ALARM, { periodInMinutes: minutes });
  }
  await chrome.storage.local.set({ stepIndex });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AUTO_ALARM) triggerDownload();
});

// Re-create alarm on service worker restart if it was active
chrome.storage.local.get(['stepIndex'], stored => {
  const idx = typeof stored.stepIndex === 'number' ? stored.stepIndex : 0;
  if (idx > 0) {
    chrome.alarms.get(AUTO_ALARM, existing => {
      if (!existing) {
        chrome.alarms.create(AUTO_ALARM, { periodInMinutes: AUTO_MINUTES[idx] });
      }
    });
  }
});

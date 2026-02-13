import { getOrCreate, nowUTC, getDomain } from "./utils.js";
import { initStorage, appendEvent } from "./storage.js";

// Initialize storage cache
(async () => {
  await initStorage();
})();

// -----------------------------
// Session Handling
// -----------------------------
let session = {
  id: crypto.randomUUID(),
  lastActivity: Date.now(),
  sequence: 0
};

const SESSION_TIMEOUT = 30 * 60 * 1000;

async function loadSession() {
  return new Promise(resolve => {
    chrome.storage.local.get(["session_state"], res => {
      resolve(res.session_state || session);
    });
  });
}

async function saveSession() {
  return new Promise(resolve => {
    chrome.storage.local.set({ session_state: session }, resolve);
  });
}

function refreshSession() {
  const now = Date.now();
  if (now - session.lastActivity > SESSION_TIMEOUT) {
    session.id = crypto.randomUUID();
    session.sequence = 0;
  }
  session.lastActivity = now;
}

// -----------------------------
// Dedup Caches
// -----------------------------
const recentNavigations = new Map();
const recentSearches = new Map();
const recentProducts = new Map();
const activePages = new Map();

const PRODUCT_DEDUP_WINDOW = 3000;

// -----------------------------
// Event Builder
// -----------------------------
async function buildBaseEvent({ event_type, url, referrer }) {
  refreshSession();

  return {
    schema_version: "1.0",
    event_id: crypto.randomUUID(),
    user_id: await getOrCreate("user_id"),
    device_id: await getOrCreate("device_id"),
    session_id: session.id,
    sequence_number: ++session.sequence,

    event_type,
    timestamp_utc: nowUTC(),

    browser: "chrome",
    os: navigator.platform,

    domain: getDomain(url),
    url,
    referrer,

    dwell_time_sec: null,
    engagement: { scroll_depth_pct: null, click_count: null },
    event_properties: {}
  };
}

// -----------------------------
// Navigation
// -----------------------------
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const tabId = details.tabId;
  const url = details.url;
  const now = Date.now();

  const last = recentNavigations.get(tabId);
  if (last && last.url === url && now - last.timestamp < 2000) return;

  recentNavigations.set(tabId, { url, timestamp: now });

  activePages.set(tabId, { url, startTime: now });

  const event = await buildBaseEvent({
    event_type: "page_visit",
    url,
    referrer: details.referrer || null
  });

  appendEvent(event);
  saveSession();
});

// -----------------------------
// Search Detection
// -----------------------------
function detectSearch(url) {
  try {
    const u = new URL(url);

    if (u.hostname.includes("google"))
      return { q: u.searchParams.get("q"), engine: "google" };

    if (u.hostname.includes("bing"))
      return { q: u.searchParams.get("q"), engine: "bing" };
  } catch {}

  return null;
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url || !tab.url) return;

  const parsed = detectSearch(tab.url);
  if (!parsed || !parsed.q) return;

  const now = Date.now();
  const last = recentSearches.get(tabId);

  if (last && last.query === parsed.q && now - last.timestamp < 2000) return;

  recentSearches.set(tabId, { query: parsed.q, timestamp: now });

  const event = await buildBaseEvent({
    event_type: "search",
    url: tab.url,
    referrer: null
  });

  event.event_properties = {
    search_query: parsed.q,
    search_engine: parsed.engine
  };

  appendEvent(event);
  saveSession();
});

// -----------------------------
// Product View
// -----------------------------
chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== "PRODUCT_VIEW") return;

  const tab = sender.tab;
  if (!tab?.id || !tab?.url) return;

  const key = `${tab.id}|${tab.url}`;
  const now = Date.now();

  if (recentProducts.has(key) && now - recentProducts.get(key) < PRODUCT_DEDUP_WINDOW)
    return;

  recentProducts.set(key, now);

  const event = await buildBaseEvent({
    event_type: "product_view",
    url: tab.url,
    referrer: null
  });

  event.event_properties = {
    product_name: msg.product?.product_name || null,
    brand: msg.product?.brand || null,
    category: "unknown",
    price: null,
    currency: null
  };

  appendEvent(event);
  saveSession();
});

// -----------------------------
// Engagement (Exit)
// -----------------------------
chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== "PAGE_EXIT") return;

  const tab = sender.tab;
  if (!tab?.url) return;

  const active = activePages.get(tab.id);
  if (!active || active.url !== tab.url) return;

  activePages.delete(tab.id);

  const event = await buildBaseEvent({
    event_type: "page_engagement",
    url: tab.url,
    referrer: null
  });

  event.dwell_time_sec = msg.dwell_time_sec ?? null;
  event.engagement.scroll_depth_pct = msg.scroll_depth_pct ?? null;

  appendEvent(event);
  saveSession();
});

// -----------------------------
// Cleanup
// -----------------------------
chrome.tabs.onRemoved.addListener(tabId => {
  recentNavigations.delete(tabId);
  recentSearches.delete(tabId);
  activePages.delete(tabId);

  for (const key of recentProducts.keys()) {
    if (key.startsWith(tabId + "|")) recentProducts.delete(key);
  }
});

// Restore session on worker start
loadSession().then(s => session = s);

// ================================
// Scalable Segmented Storage Engine
// ================================

const MAX_SEGMENT_SIZE = 250000; // 250KB per segment
const META_KEY = "user_logs_meta";

let metaCache = null;
let metaDirty = false;
// let metaFlushIntervalStarted = false;

// ================================
// Initialization
// ================================

export async function initStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["user_logs_meta"], (res) => {
      metaCache = res.user_logs_meta  || {
        current_segment: 0,
        current_size: 0
      };

      // Start periodic meta flush once
      // if (!metaFlushIntervalStarted) {
      //   startMetaFlushInterval();
      //   metaFlushIntervalStarted = true;
      // }

      resolve();
    });
  });
}

// ================================
// Segment Append Helper
// ================================

async function appendToSegment(segmentKey, data) {
  return new Promise((resolve) => {
    chrome.storage.local.get([segmentKey], (res) => {
      const existing = res[segmentKey] || "";
      chrome.storage.local.set({
        [segmentKey]: existing + data
      }, resolve);
    });
  });
}


// ================================
// Append Event (Optimized)
// ================================

export async function appendEvent(event) {

  // Check if logging is enabled
  const { logging_enabled } = await new Promise(resolve =>
    chrome.storage.local.get(["logging_enabled"], resolve)
  );

  if (!logging_enabled) return;

  // Ensure metaCache is loaded
  if (!metaCache) return;

  const eventLine = JSON.stringify(event) + "\n";
  const eventSize = eventLine.length;

  let segmentKey = `user_logs_segment_${metaCache.current_segment}`;

  // Rotate segment if needed
  if (metaCache.current_size + eventSize > MAX_SEGMENT_SIZE) {
    metaCache.current_segment += 1;
    metaCache.current_size = 0;
    segmentKey = `user_logs_segment_${metaCache.current_segment}`;
  }

  await appendToSegment(segmentKey, eventLine);

  metaCache.current_size += eventSize;
  metaDirty = true;
}

// ================================
// Periodic Meta Flush
// ================================

setInterval(() => {
  if (metaDirty && metaCache) {
    chrome.storage.local.set({
      [META_KEY]: metaCache
    });
    metaDirty = false;
  }
}, 5000);

// ================================
// Export Helper (Concatenate All Segments)
// ================================

export async function exportAllLogs() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (res) => {
      const segments = Object.keys(res)
        .filter(k => k.startsWith("user_logs_segment_"))
        .sort((a, b) => {
          const na = parseInt(a.split("_").pop());
          const nb = parseInt(b.split("_").pop());
          return na - nb;
        });

      let combined = "";

      segments.forEach(seg => {
        combined += res[seg];
      });

      resolve(combined);
    });
  });
}

// ================================
// Clear All Logs
// ================================

export async function clearAllLogs() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (res) => {
      const keys = Object.keys(res).filter(k =>
        k.startsWith("user_logs_segment_") ||
        k === META_KEY
      );

      chrome.storage.local.remove(keys, () => {
        metaCache = {
          current_segment: 0,
          current_size: 0
        };
        metaDirty = false;
        resolve();
      });
    });
  });
}



export async function getOrCreate(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => {
      if (res[key]) return resolve(res[key]);
      const val = crypto.randomUUID();
      chrome.storage.local.set({ [key]: val });
      resolve(val);
    });
  });
}

export function nowUTC() {
  return new Date().toISOString();
}

export function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

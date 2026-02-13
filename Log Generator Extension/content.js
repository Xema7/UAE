let maxScroll = 0;
let startTime = Date.now();

let scrollTimeout = null;

window.addEventListener("scroll", () => {
  if (scrollTimeout) return;

  scrollTimeout = setTimeout(() => {
    const scrolled = window.scrollY + window.innerHeight;
    const total = document.documentElement.scrollHeight;
    maxScroll = Math.max(
      maxScroll,
      Math.round((scrolled / total) * 100)
    );
    scrollTimeout = null;
  }, 250);
});


window.addEventListener("beforeunload", () => {
  chrome.runtime.sendMessage({
    type: "PAGE_EXIT",
    dwell_time_sec: Math.round((Date.now() - startTime) / 1000),
    scroll_depth_pct: maxScroll
  });
});

// Product Detector
function detectProductPage() {
  const metas = [...document.getElementsByTagName("meta")];

  const ogType = metas.find(m => m.property === "og:type")?.content;
  const brand = metas.find(m => m.property === "product:brand")?.content;

  const title = document.querySelector("h1")?.innerText;

  let score = 0;
  if (ogType === "product") score++;
  if (brand) score++;
  if (title && title.length > 5 && title.length < 120) score++;

  if (score < 2) return null;

  return {
    product_name: title || document.title,
    brand: brand || null
  };
}

window.addEventListener("load", () => {
  const product = detectProductPage();
  if (!product) return;

  chrome.runtime.sendMessage({
    type: "PRODUCT_VIEW",
    product
  });
});

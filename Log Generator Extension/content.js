// content.js — BehaviorLens v4 Content Script
// Emits structured events with detailed event_properties per event type.

(function () {
  if (window.__behaviorLensV4) return;
  window.__behaviorLensV4 = true;

  const HOST = location.hostname.replace('www.', '');

  function cleanUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
      const KEEP = new Set([
        'q','query','search_query','keyword','k','field-keywords',
        'v','t','list','index','tbm','num','start',
        'page','p','sort','order','category','brand','color','size',
        'th','psc',
      ]);
      const TRACKERS = [
        /^utm_/,/^ref/,/^_encoding/,/^pd_rd/,/^pf_rd/,/^content-id/,
        /^s$/,/^sprefix/,/^crid/,/^qid/,/^rnid/,/^linkCode/,/^tag/,
        /^linkId/,/^camp/,/^creative/,/^adid/,/^gclid/,/^fbclid/,
        /^msclkid/,/^twclid/,/^ttclid/,/^dclid/,/^mc_/,/^yclid/,
        /^igshid/,/^epik/,/^srsltid/,/^ved/,/^ei/,/^sa$/,/^usg/,/^oq/,/^gs_/,
      ];
      const u = new URL(rawUrl);
      const out = new URLSearchParams();
      for (const [k, v] of u.searchParams.entries()) {
        if (KEEP.has(k) && !TRACKERS.some(r => r.test(k))) out.append(k, v);
      }
      const qs = out.toString();
      return u.origin + u.pathname + (qs ? '?' + qs : '');
    } catch { return rawUrl; }
  }

  // FIX (Refactor #4): Acknowledge lastError to suppress Chrome's unchecked-error warning.
  function send(data) {
    try {
      chrome.runtime.sendMessage({ type: 'content_event', data }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  function trunc(s, n = 150) {
    if (!s) return null;
    s = String(s).trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function cleanPrice(raw) {
    if (!raw) return null;
    return raw.replace(/\s+/g, ' ').replace(/[^\d.,₹$€£¥]/g, '').trim().slice(0, 30) || null;
  }

  // ── Engagement tracking (scroll depth + click count) ─────────────────────
  let scrollDepth = 0;
  let clickCount  = 0;

  window.addEventListener('scroll', () => {
    const pct = Math.round(((window.scrollY + window.innerHeight) / Math.max(1, document.body.scrollHeight)) * 100);
    if (pct > scrollDepth + 10) {
      scrollDepth = Math.min(100, pct);
      send({ event_type: 'engagement_update', _scrollDepth: scrollDepth });
    }
  }, { passive: true });

  document.addEventListener('click', () => {
    clickCount++;
    send({ event_type: 'engagement_update', _clickDelta: 1 });
  }, true);

  // ── 1. SEARCH ─────────────────────────────────────────────────────────────
  function detectSearch() {
    const url    = location.href;
    const params = new URLSearchParams(location.search);

    const matchers = [
      { host: /google\./,   path: /\/search/,   params: ['q'],                         engine: 'Google',   category: 'search_engine' },
      { host: /youtube\./,  path: /\/results/,  params: ['search_query'],              engine: 'YouTube',  category: 'video' },
      { host: /amazon\./,   path: /\/s/,        params: ['k','field-keywords','query'],engine: 'Amazon',   category: 'ecommerce' },
      { host: /flipkart\./,               path: /\/search/, params: ['q'],             engine: 'Flipkart', category: 'ecommerce' },
      { host: /myntra\./,                 path: /\/search/, params: ['q'],             engine: 'Myntra',   category: 'ecommerce' },
      { host: /meesho\./,                 path: /\/search/, params: ['q'],             engine: 'Meesho',   category: 'ecommerce' },
      { host: /snapdeal\./,               path: /\/search/, params: ['keyword'],       engine: 'Snapdeal', category: 'ecommerce' },
      { host: /nykaa\./,                  path: /\/search/, params: ['q'],             engine: 'Nykaa',    category: 'ecommerce' },
      { host: /ajio\./,                   path: /\/search/, params: ['query'],         engine: 'Ajio',     category: 'ecommerce' },
      { host: /reddit\./,                 path: /\/search/, params: ['q'],             engine: 'Reddit',   category: 'social_media' },
      { host: /instagram\./,              path: /\/explore\/search/, params: ['q'],   engine: 'Instagram',category: 'social_media' },
    ];

    for (const m of matchers) {
      if (!m.host.test(HOST)) continue;
      if (!m.path.test(url)) continue;
      const q = m.params.map(p => params.get(p)).find(Boolean);
      if (!q) continue;

      send({
        event_type: 'search',
        _icon: '🔍', _label: `${m.engine} Search`, _detail: q, _category: 'Search', _site: m.engine,
        event_properties: {
          content_category: m.category,
          search_engine:    m.engine,
          search_query:     q,
          search_type:      'organic',
          result_count:     null,
        }
      });
      return;
    }
  }

  // ── 2. VIDEO ──────────────────────────────────────────────────────────────
  const trackedVideos = new WeakSet();

  function getVideoMeta() {
    if (HOST.includes('youtube')) {
      const titleEl = document.querySelector(
        'h1.ytd-video-primary-info-renderer yt-formatted-string, ' +
        '#above-the-fold #title h1, ' +
        'ytd-watch-metadata h1'
      );
      const channelEl = document.querySelector('#channel-name a, #owner-name a, ytd-channel-name a');
      const videoId   = new URLSearchParams(location.search).get('v');
      return {
        platform:     'YouTube',
        video_title:  trunc(titleEl?.textContent) || trunc(document.title?.replace(' - YouTube', '')),
        video_id:     videoId,
        channel_name: trunc(channelEl?.textContent),
        video_url:    location.href,
        duration_sec: null,
        content_category: 'video',
      };
    }
    if (HOST.includes('netflix')) {
      const title = document.querySelector('.ellipsize-text h4, [data-uia="video-title"], .title-card-container .fallback-text')?.textContent?.trim()
        || document.title?.replace(' | Netflix', '');
      return {
        platform: 'Netflix', video_title: trunc(title), video_id: null,
        channel_name: null, video_url: cleanUrl(location.href), duration_sec: null,
        content_category: 'video',
      };
    }
    if (HOST.includes('instagram')) {
      const alt = document.querySelector('video')?.closest('article')?.querySelector('img')?.alt;
      const title = alt || document.title?.replace(' • Instagram', '') || 'Instagram Reel';
      return {
        platform: 'Instagram', video_title: trunc(title), video_id: location.pathname,
        channel_name: location.pathname.split('/')[1] || null,
        video_url: cleanUrl(location.href), duration_sec: null,
        content_category: 'social_media',
      };
    }
    if (HOST.includes('primevideo')) {
      const title = document.querySelector('.atvwebplayersdk-title-text, [data-testid="title"]')?.textContent?.trim()
        || document.title?.replace('Watch', '').replace('| Prime Video', '').trim();
      return {
        platform: 'Prime Video', video_title: trunc(title), video_id: null,
        channel_name: null, video_url: cleanUrl(location.href), duration_sec: null,
        content_category: 'video',
      };
    }
    if (HOST.includes('hotstar')) {
      const title = document.querySelector('[class*="title"] h1, h1')?.textContent?.trim()
        || document.title?.replace('| Hotstar', '').trim();
      return {
        platform: 'Hotstar', video_title: trunc(title), video_id: null,
        channel_name: null, video_url: cleanUrl(location.href), duration_sec: null,
        content_category: 'video',
      };
    }
    return {
      platform: HOST, video_title: trunc(document.title), video_id: null,
      channel_name: null, video_url: cleanUrl(location.href), duration_sec: null,
      content_category: 'video',
    };
  }

  function attachVideo(video) {
    if (trackedVideos.has(video)) return;
    trackedVideos.add(video);
    let playStart = null;
    // FIX (Warning #1): Accumulate watched time across pause/play cycles.
    let totalWatched = 0;
    let meta = null;

    video.addEventListener('play', () => {
      playStart = Date.now();
      meta = getVideoMeta();
      if (video.duration && isFinite(video.duration)) meta.duration_sec = Math.round(video.duration);
      send({
        event_type: 'video_play',
        _icon: '▶️', _label: 'Video Started', _detail: meta.video_title, _category: 'Video', _site: meta.platform,
        event_properties: { ...meta, playback_action: 'play', watch_time_sec: totalWatched }
      });
    });

    video.addEventListener('pause', () => {
      if (playStart) {
        totalWatched += Math.round((Date.now() - playStart) / 1000);
        playStart = null;
      }
      if (!meta) meta = getVideoMeta();
      send({
        event_type: 'video_pause',
        _icon: '⏸️', _label: 'Video Paused', _detail: `${meta.video_title} (${totalWatched}s watched)`, _category: 'Video', _site: meta.platform,
        event_properties: { ...meta, playback_action: 'pause', watch_time_sec: totalWatched }
      });
    });

    video.addEventListener('ended', () => {
      if (playStart) {
        totalWatched += Math.round((Date.now() - playStart) / 1000);
        playStart = null;
      }
      if (!meta) meta = getVideoMeta();
      send({
        event_type: 'video_complete',
        _icon: '✅', _label: 'Video Finished', _detail: `${meta.video_title} (${totalWatched}s watched)`, _category: 'Video', _site: meta.platform,
        event_properties: { ...meta, playback_action: 'complete', watch_time_sec: totalWatched }
      });
      // Reset accumulator after completion
      totalWatched = 0;
    });

    video.addEventListener('seeked', () => {
      if (!meta) return;
      const pos = Math.round(video.currentTime);
      send({
        event_type: 'video_seek',
        _icon: '⏩', _label: 'Video Seeked', _detail: `${meta.video_title} → ${pos}s`, _category: 'Video', _site: meta.platform,
        event_properties: { ...meta, playback_action: 'seek', seek_position_sec: pos }
      });
    });
  }

  // FIX (Bug #3): Store observer reference on window so it is never duplicated
  // across SPA navigations and can be disconnected if needed.
  function trackVideos() {
    if (window.__blVideoObs) return;
    document.querySelectorAll('video').forEach(attachVideo);
    const obs = new MutationObserver(() =>
      document.querySelectorAll('video').forEach(attachVideo)
    );
    obs.observe(document.documentElement, { childList: true, subtree: true });
    window.__blVideoObs = obs;
  }

  // ── 3. PRODUCT VIEWED ────────────────────────────────────────────────────
  // FIX (Refactor #2): Config-driven table replaces 100-line if/else chain.
  // Each rule: { host, path, selectors: { name, price, brand, category }, platform, currency }
  const PRODUCT_RULES = [
    {
      host: /amazon/, path: /\/dp\/|\/gp\/product\//,
      platform: 'Amazon', currency: null, // determined by price symbol
      selectors: {
        name:     '#productTitle',
        price:    '.a-price-whole, #priceblock_ourprice, #priceblock_dealprice, .a-offscreen',
        brand:    '#bylineInfo, #brand',
        category: '#wayfinding-breadcrumbs_container li:last-child',
      },
      postProcess(props) {
        props.product_id = location.pathname.match(/\/dp\/([A-Z0-9]+)/)?.[1] || null;
        const rawBrand = props.brand;
        if (rawBrand) props.brand = rawBrand.replace(/^Visit the |Store$/gi, '');
        const rawPrice = document.querySelector('.a-price-whole, #priceblock_ourprice, #priceblock_dealprice, .a-offscreen')?.textContent || '';
        props.currency = rawPrice.includes('₹') ? 'INR' : rawPrice.includes('$') ? 'USD' : null;
      },
    },
    {
      host: /flipkart/, path: /\/p\//,
      platform: 'Flipkart', currency: 'INR',
      selectors: {
        name:     'span.B_NuCI, h1.yhB1nd, h1._6EBuvT, h1',
        price:    'div._30jeq3._16Jk6d, div._30jeq3',
        category: '._2whKao li:last-child',
      },
    },
    {
      host: /myntra/, path: /buy/,
      platform: 'Myntra', currency: 'INR',
      selectors: {
        name:  'h1.pdp-title, .pdp-name, h1',
        price: '.pdp-price strong, .pdp-mrp strong, [class*="price"]',
        brand: '.pdp-title, h1',
      },
    },
    {
      host: /meesho/, path: /\/product\/|\/p\//,  // FIX (Warning #3): Added path guard
      platform: 'Meesho', currency: 'INR',
      selectors: {
        name:  'h1',
        price: '[class*="price"], h5',
      },
    },
    {
      host: /snapdeal/, path: /\/product\//,
      platform: 'Snapdeal', currency: 'INR',
      selectors: {
        name:  '.pdp-e-i-head, h1',
        price: '.payBlkBig, [class*="price"]',
      },
    },
    {
      host: /nykaa/, path: /\/p\/|\/buy/,
      platform: 'Nykaa', currency: 'INR',
      selectors: {
        name:  'h1, [class*="product-title"]',
        price: '[class*="price"]',
      },
    },
    {
      host: /ajio/, path: /\/p\//,
      platform: 'Ajio', currency: 'INR',
      selectors: {
        name:  'h1, [class*="prod-name"]',
        price: '[class*="prod-price"], [class*="price"]',
      },
    },
  ];

  function detectProduct() {
    // Try config-driven rules first
    const rule = PRODUCT_RULES.find(r =>
      r.host.test(HOST) && r.path.test(location.pathname)
    );

    let props = null;

    if (rule) {
      const sel = rule.selectors;
      const rawName  = sel.name     ? document.querySelector(sel.name)?.textContent?.trim()     : null;
      const rawPrice = sel.price    ? document.querySelector(sel.price)?.textContent?.trim()    : null;
      const rawBrand = sel.brand    ? document.querySelector(sel.brand)?.textContent?.trim()    : null;
      const rawCat   = sel.category ? document.querySelector(sel.category)?.textContent?.trim() : null;

      props = {
        content_category:  'ecommerce',
        platform:          rule.platform,
        product_name:      trunc(rawName),
        brand:             trunc(rawBrand) || null,
        price:             cleanPrice(rawPrice),
        currency:          rule.currency,
        product_category:  rawCat || null,
        product_url:       cleanUrl(location.href),
      };

      if (rule.postProcess) rule.postProcess(props);

    } else {
      // FIX (Bug #5): Use querySelectorAll to iterate all JSON-LD blocks,
      // not just the first one (which is usually breadcrumbs/org, not Product).
      document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
        if (props) return;
        try {
          const d = JSON.parse(el.textContent);
          const arr = Array.isArray(d) ? d : [d];
          const p = arr.find(x => x['@type'] === 'Product');
          if (p) {
            props = {
              content_category: 'ecommerce',
              platform:         HOST,
              product_name:     trunc(p.name),
              brand:            p.brand?.name || null,
              price:            p.offers?.price ? String(p.offers.price) : null,
              currency:         p.offers?.priceCurrency || null,
              product_category: null,
              product_url:      cleanUrl(location.href),
            };
          }
        } catch (_) {}
      });
      if (!props) return;
    }

    if (props) {
      send({
        event_type: 'product_view',
        _icon: '🛍️', _label: 'Product Viewed',
        _detail: `${props.product_name || 'Product'}${props.price ? ' — ' + props.price : ''}`,
        _category: 'Product', _site: props.platform,
        event_properties: props,
      });
    }
  }

  // ── 4. ARTICLE READ ──────────────────────────────────────────────────────
  const ARTICLE_SEL = [
    'article', '[role="article"]', '[itemprop="articleBody"]',
    '.article-body', '.article__body', '.article-content', '.article-text',
    '.post-content', '.post-body', '.entry-content',
    '.story-body', '.story-content',
    '#article-body', '#story-body',
    '.content-article', '[class*="articleBody"]',
    '.blog-content', '.blog-post',
  ];

  const SKIP_ARTICLE = /amazon\.|flipkart\.|myntra\.|meesho\.|snapdeal\.|nykaa\.|ajio\.|tatacliq\.|google\.com\/(search|maps)|youtube\.com\/(watch|results|shorts)|instagram\.com\/(?!p\/)|facebook\.com\/(?!notes)/;

  function getArticleMeta() {
    const schema = document.querySelector('script[type="application/ld+json"]');
    if (schema) {
      try {
        const d = JSON.parse(schema.textContent);
        const arr = Array.isArray(d) ? d : [d];
        const a = arr.find(x => ['Article','NewsArticle','BlogPosting','TechArticle'].includes(x['@type']));
        if (a) return {
          article_title:    trunc(a.headline || document.querySelector('h1')?.textContent?.trim()),
          author:           a.author?.name || (Array.isArray(a.author) ? a.author[0]?.name : null) || null,
          publication_date: a.datePublished || null,
          publisher:        a.publisher?.name || HOST,
          tags:             a.keywords ? String(a.keywords).split(',').map(s=>s.trim()).slice(0,5) : null,
        };
      } catch (_) {}
    }
    const authorEl = document.querySelector('[class*="author"], [rel="author"], [itemprop="author"], .byline');
    const dateEl   = document.querySelector('time, [itemprop="datePublished"], [class*="date"], [class*="publish"]');
    return {
      article_title:    trunc(document.querySelector('h1')?.textContent?.trim() || document.title),
      author:           trunc(authorEl?.textContent) || null,
      publication_date: dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim()?.slice(0,30) || null,
      publisher:        HOST,
      tags:             null,
    };
  }

  // FIX (Bug #4): Track and remove the article scroll handler on SPA navigation
  // so stale handlers from previous routes don't linger.
  let _articleScrollHandler = null;

  function trackArticle() {
    if (SKIP_ARTICLE.test(location.href)) return;
    const el = ARTICLE_SEL.map(s => document.querySelector(s)).find(Boolean);
    if (!el) return;
    const text = el.innerText?.trim() || '';
    if (text.length < 300) return;

    const words   = text.split(/\s+/).length;
    const readMin = Math.max(1, Math.ceil(words / 220));
    let fired = false;

    // Remove any previous article handler before attaching a new one
    if (_articleScrollHandler) {
      window.removeEventListener('scroll', _articleScrollHandler);
      _articleScrollHandler = null;
    }

    function handler() {
      if (fired) return;
      const pct = ((window.scrollY + window.innerHeight) / Math.max(1, document.body.scrollHeight));
      if (pct >= 0.62) {
        fired = true;
        const meta = getArticleMeta();
        send({
          event_type: 'article_read',
          _icon: '📰', _label: 'Article Read', _detail: `${meta.article_title} (~${readMin} min)`,
          _category: 'Article', _site: HOST,
          event_properties: {
            content_category:   'article',
            ...meta,
            word_count:         words,
            estimated_read_min: readMin,
            scroll_trigger_pct: 62,
            article_url:        location.href,
          },
        });
        window.removeEventListener('scroll', handler);
        _articleScrollHandler = null;
      }
    }

    _articleScrollHandler = handler;
    window.addEventListener('scroll', handler, { passive: true });
  }

  // ── 5. AD CLICKED ────────────────────────────────────────────────────────
  const AD_ROOTS = [
    '#tads', '#bottomads', '[data-text-ad]', '.commercial-unit-desktop-top',
    'ins.adsbygoogle', '[id*="google_ads"]', '[id*="div-gpt-ad"]',
    '[data-component-type="sp-sponsored-result"]', '[class*="AdHolder"]',
    '[aria-label*="Sponsored"]', '[aria-label*="Advertisement"]',
    '[data-ad-slot]', '[data-ad-client]',
  ];

  function isAdElement(el) {
    let node = el;
    for (let i = 0; i < 6; i++) {
      if (!node || node === document.body) break;
      const cls = (node.className || '').toLowerCase();
      const id  = (node.id || '').toLowerCase();
      if (cls.includes('sponsor') || cls.includes('advert') || cls.includes('-ad-') ||
          id.includes('ad-') || id.includes('_ad_') ||
          node.getAttribute('data-ad-slot') || node.getAttribute('data-text-ad') !== null) return true;
      if (AD_ROOTS.some(sel => { try { return node.matches(sel); } catch { return false; } })) return true;
      node = node.parentElement;
    }
    return false;
  }

  // FIX (Warning #6): Guard trackAds() so the click listener is only ever
  // attached once — even across SPA navigations that re-call it.
  let _adsTracked = false;

  function trackAds() {
    if (_adsTracked) return;
    _adsTracked = true;

    document.addEventListener('click', (e) => {
      const target = e.target.closest('a, [role="link"]') || e.target;
      if (!isAdElement(target)) return;

      const adText     = target.querySelector('h3, h2')?.textContent?.trim() || target.textContent?.trim()?.slice(0, 100) || null;
      const advertiser = target.closest('[data-text-ad]')?.querySelector('.x2VHCd, .lerLLe')?.textContent?.trim()
        || target.closest('[data-component-type="sp-sponsored-result"]')?.querySelector('.a-size-base')?.textContent?.trim()
        || null;
      const destUrl    = cleanUrl(target.href) || null;

      send({
        event_type: 'ad_click',
        _icon: '📣', _label: 'Ad Clicked', _detail: trunc(adText) || 'Ad',
        _category: 'Ad', _site: HOST,
        event_properties: {
          content_category:  'advertisement',
          ad_text:           trunc(adText),
          advertiser_name:   trunc(advertiser),
          destination_url:   cleanUrl(destUrl),
          ad_platform:       HOST.includes('google') ? 'Google Ads' :
                             HOST.includes('amazon') ? 'Amazon Sponsored' : 'Display',
          ad_position:       null,
        }
      });
    }, true);
  }

  // ── 6. PURCHASE ───────────────────────────────────────────────────────────
  function trackPurchase() {
    let fired = false;

    function emitPurchase(props) {
      if (fired) return;
      fired = true;
      send({
        event_type: 'purchase',
        _icon: '💳', _label: 'Purchase Completed',
        _detail: props.order_id ? `Order #${props.order_id}` : props.platform,
        _category: 'Purchase', _site: props.platform,
        event_properties: {
          content_category: 'ecommerce',
          ...props,
          purchase_url: cleanUrl(location.href),
        }
      });
    }

    function scrape() {
      if (HOST.includes('amazon')) {
        const isConfirm = /\/gp\/buy\/thankyou|\/gp\/css\/order-history|order-confirmation|\/orders\//.test(location.pathname)
          || !!document.querySelector('[class*="order-confirm"], [class*="thank-you"]');
        if (!isConfirm) return;
        const orderId = document.querySelector('[class*="order-id"] span, #orderID')?.textContent?.trim()
          || location.href.match(/orderId=([A-Z0-9-]+)/)?.[1] || null;
        const total   = document.querySelector('[class*="grand-total"] .a-offscreen, [class*="order-total"]')?.textContent?.trim() || null;
        const items   = [...document.querySelectorAll('[class*="product-title"]')]
          .map(el => el.textContent?.trim()).filter(Boolean).slice(0, 5);
        emitPurchase({ platform: 'Amazon', order_id: orderId, order_total: total, currency: 'INR', items });
        return;
      }
      if (HOST.includes('flipkart')) {
        if (!/order.*confirm|thank.*order|\/checkout\/thank/i.test(location.pathname + document.title)) return;
        const orderId = document.querySelector('[class*="order-id"], [class*="orderId"]')?.textContent?.trim()?.replace(/[^A-Z0-9-]/gi,'') || null;
        const total   = document.querySelector('[class*="total-amount"], [class*="totalAmount"]')?.textContent?.trim() || null;
        emitPurchase({ platform: 'Flipkart', order_id: orderId, order_total: total, currency: 'INR', items: [] });
        return;
      }
      if (HOST.includes('myntra')) {
        if (!/order.*confirm|thank|success/i.test(document.title + location.pathname)) return;
        const orderId = document.querySelector('[class*="order-id"], [class*="orderId"]')?.textContent?.trim() || null;
        const total   = document.querySelector('[class*="total"], [class*="amount"]')?.textContent?.trim() || null;
        emitPurchase({ platform: 'Myntra', order_id: orderId, order_total: total, currency: 'INR', items: [] });
        return;
      }
      if (HOST.includes('meesho')) {
        if (!/order.*place|thank|success/i.test(document.title + location.pathname)) return;
        emitPurchase({ platform: 'Meesho', order_id: null, order_total: null, currency: 'INR', items: [] });
        return;
      }
      if (HOST.includes('nykaa')) {
        if (!/order.*confirm|thank|success/i.test(document.title + location.pathname)) return;
        const orderId = document.querySelector('[class*="order"]')?.textContent?.match(/[A-Z0-9]{6,}/)?.[0] || null;
        emitPurchase({ platform: 'Nykaa', order_id: orderId, order_total: null, currency: 'INR', items: [] });
        return;
      }
      // Generic JSON-LD Order schema fallback
      document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
        try {
          const d = JSON.parse(el.textContent);
          const arr = Array.isArray(d) ? d : [d];
          const order = arr.find(x => x['@type'] === 'Order');
          if (order && !fired) {
            emitPurchase({
              platform:    HOST,
              order_id:    order.orderNumber || null,
              order_total: order.price || order.totalPrice || null,
              currency:    order.priceCurrency || null,
              items:       (order.orderedItem || []).map(i => i.name).filter(Boolean).slice(0, 5),
            });
          }
        } catch (_) {}
      });
    }

    window.addEventListener('load', () => setTimeout(scrape, 1200));

    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState    = (...a) => { origPush(...a);    setTimeout(scrape, 1500); };
    history.replaceState = (...a) => { origReplace(...a); setTimeout(scrape, 1500); };
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  detectSearch();
  trackVideos();
  trackAds();
  trackPurchase();

  window.addEventListener('load', () => {
    setTimeout(() => {
      detectProduct();
      trackArticle();
    }, 1500);
  });

  // FIX (Warning #4): Debounced SPA observer — shorter timeout (800ms) with
  // clearTimeout to prevent stacking on rapid navigations.
  let _spaTimer = null;
  let lastHref  = location.href;

  new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      clearTimeout(_spaTimer);
      _spaTimer = setTimeout(() => {
        detectSearch();
        detectProduct();
        // FIX (Bug #4): Clean up the previous article handler before re-running
        trackArticle();
      }, 800);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

})();

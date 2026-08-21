(() => {
  'use strict';
  if (globalThis.__openSubSubtitleDiscoveryInstalled) return;
  globalThis.__openSubSubtitleDiscoveryInstalled = true;

  const MAX_RESOURCE_TEXT = 3 * 1024 * 1024;
  const MAX_URLS_PER_SESSION = 90;
  const REPLAY_LIMIT = 12;
  const seenUrls = new Set();
  const queuedUrls = new Set();
  const recentPayloads = [];
  let sessionKey = '';
  let scanTimer = 0;
  let scanPasses = 0;

  const DIRECT_HINT = /(?:caption|captions|subtitle|subtitles|timedtext|timed-text|texttrack|webvtt|ttml|dfxp|ebu-?tt|ebutt|\.vtt(?:$|[?#])|\.srt(?:$|[?#])|\.ttml(?:$|[?#])|\.dfxp(?:$|[?#])|\.smi(?:$|[?#])|\.xml(?:$|[?#]))/i;
  const MANIFEST_HINT = /(?:\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])|manifest|playlist)/i;
  const METADATA_HINT = /(?:\/api(?:\/|$)|player|playback|media|video|asset|stream|content|ptmd|profile|config|metadata|graphql|teaser|frontend)/i;
  const SUBTITLE_KEY_HINT = /(?:caption|subtitle|timed.?text|text.?track|webvtt|ttml|dfxp|ebu.?tt|ebutt|closed.?caption|\but\b)/i;

  function currentSessionKey(raw = location.href) {
    try {
      const u = new URL(raw, location.href);
      u.hash = '';
      const host = u.hostname.replace(/^www\./i, '').toLowerCase();
      if ((host === 'youtube.com' || host === 'm.youtube.com') && u.pathname === '/watch') {
        const videoId = u.searchParams.get('v');
        if (videoId) return `${u.origin}/watch?v=${videoId}`;
      }
      return `${u.origin}${u.pathname}${u.search}`;
    } catch (_) {
      return String(raw || '').split('#')[0];
    }
  }

  function syncSession() {
    const next = currentSessionKey();
    if (!sessionKey) sessionKey = next;
    if (next !== sessionKey) {
      sessionKey = next;
      seenUrls.clear();
      queuedUrls.clear();
      recentPayloads.length = 0;
      scanPasses = 0;
    }
    return sessionKey;
  }

  function absoluteUrl(raw, base = location.href) {
    const text = String(raw || '').trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!text || /^(?:blob:|data:|javascript:|about:)/i.test(text)) return '';
    try { return new URL(text, base).href; } catch (_) { return ''; }
  }

  function payloadKey(payload) {
    return `${payload?.url || ''}|${payload?.format || ''}|${payload?.text?.length || 0}`;
  }

  function remember(payload) {
    const key = payloadKey(payload);
    const idx = recentPayloads.findIndex(item => payloadKey(item) === key);
    if (idx >= 0) recentPayloads.splice(idx, 1);
    recentPayloads.unshift(payload);
    if (recentPayloads.length > REPLAY_LIMIT) recentPayloads.length = REPLAY_LIMIT;
  }

  function emit(url, contentType, text, format, via = 'resource-discovery') {
    if (!text || text.length > MAX_RESOURCE_TEXT) return;
    const payload = {
      url: String(url || location.href),
      contentType: String(contentType || ''),
      text: String(text),
      via,
      format: String(format || 'Timed text'),
      capturedAt: Date.now()
    };
    remember(payload);
    try { window.postMessage({ source: 'opensub-network-probe', payload }, '*'); } catch (_) {}
  }

  function looksLikeTimedSubtitle(text, contentType = '', url = '') {
    const sample = String(text || '').slice(0, 18000);
    const meta = `${contentType} ${url}`;
    return /^WEBVTT\b/m.test(sample)
      || /(?:^|\n)\s*(?:\d+\s*\n\s*)?\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(sample)
      || /<(?:[a-z0-9_.-]+:)?tt(?:\s|>)/i.test(sample)
      || /<(?:[a-z0-9_.-]+:)?p\b[^>]*(?:begin|end|dur)\s*=/i.test(sample)
      || /<sync\b[^>]*\bstart\s*=/i.test(sample)
      || /"(?:tStartMs|dDurationMs|startTimeMs|caption|subtitle|cues|timedText)"\s*:/i.test(sample)
      || /(?:text\/vtt|application\/ttml\+xml|application\/x-subrip|ebu-?tt|ebutt|\.vtt|\.srt|\.ttml|\.dfxp)/i.test(meta) && /(?:-->|<|\{|\[)/.test(sample);
  }

  function formatHint(url, contentType, text) {
    const value = `${url || ''} ${contentType || ''}`.toLowerCase();
    const sample = String(text || '').slice(0, 1400);
    if (/^WEBVTT\b/m.test(sample) || /webvtt|text\/vtt|\.vtt/.test(value)) return 'WebVTT';
    if (/ebu-?tt|ebutt|EBU-TT-D/i.test(sample) || /ebu-?tt|ebutt/.test(value)) return 'EBU-TT-D / TTML';
    if (/<(?:[a-z0-9_.-]+:)?tt(?:\s|>)/i.test(sample) || /ttml|dfxp/.test(value)) return 'TTML/DFXP';
    if (/\.srt/.test(value) || /-->/.test(sample)) return 'SRT';
    if (/\.smi|sami/.test(value) || /<sync\b/i.test(sample)) return 'SAMI';
    if (/^[\s\r\n]*[\[{]/.test(sample) || /json/.test(value)) return 'JSON timed text';
    return 'Timed text';
  }

  function parseHlsAttributes(line) {
    const attrs = {};
    const body = String(line || '').replace(/^[^:]*:/, '');
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
    let m;
    while ((m = re.exec(body))) attrs[m[1].toUpperCase()] = m[3] !== undefined ? m[3] : String(m[2] || '').trim();
    return attrs;
  }

  function extractStringsFromJson(text, baseUrl) {
    let data;
    try { data = JSON.parse(text); } catch (_) { return []; }
    const found = new Set();
    const visit = (node, path = '') => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, path);
        return;
      }

      const descriptor = [node.kind, node.type, node.format, node.mimeType, node.mime_type, node.class, node.role]
        .filter(v => typeof v === 'string').join(' ');
      const objectLooksSubtitle = SUBTITLE_KEY_HINT.test(`${path} ${descriptor}`);
      if (objectLooksSubtitle) {
        for (const key of ['url', 'uri', 'src', 'source', 'href', 'xml_url', 'ttml_url', 'vtt_url', 'srt_url', '_subtitleUrl']) {
          if (typeof node[key] === 'string') {
            const u = absoluteUrl(node[key], baseUrl);
            if (u) found.add(u);
          }
        }
      }

      for (const [key, value] of Object.entries(node)) {
        const nextPath = `${path}.${key}`;
        if (typeof value === 'string') {
          if (SUBTITLE_KEY_HINT.test(nextPath) || DIRECT_HINT.test(value)) {
            const u = absoluteUrl(value, baseUrl);
            if (u) found.add(u);
          }
        } else if (value && typeof value === 'object') {
          visit(value, nextPath);
        }
      }
    };
    visit(data, 'root');
    return [...found];
  }

  function extractSubtitleUrlsFromText(text, baseUrl, contentType = '') {
    const found = new Set();
    const raw = String(text || '');

    if (/json/i.test(contentType) || /^[\s\r\n]*[\[{]/.test(raw)) {
      for (const url of extractStringsFromJson(raw, baseUrl)) found.add(url);
    }

    // Absolute and relative URL strings in HTML/XML/JSON. Only retain strings that themselves
    // look subtitle-related to avoid turning metadata discovery into a general-purpose crawler.
    const normalized = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const urlRegex = /(?:https?:\/\/[^\s"'<>\\]+|(?:\.\.\/|\.\/|\/)[^\s"'<>\\]+)/g;
    for (const match of normalized.matchAll(urlRegex)) {
      const candidate = String(match[0] || '').replace(/[),;]+$/, '');
      if (!DIRECT_HINT.test(candidate)) continue;
      const u = absoluteUrl(candidate, baseUrl);
      if (u) found.add(u);
    }

    return [...found];
  }

  async function fetchResource(url) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'opensub-fetch-resource',
        url,
        pageUrl: location.href,
        maxBytes: MAX_RESOURCE_TEXT
      });
      return result && result.ok ? result : null;
    } catch (_) {
      return null;
    }
  }

  async function processHls(url, text, depth) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const targets = new Set();
    let hasSubtitleMedia = false;

    for (const line of lines) {
      if (/^#EXT-X-MEDIA:/i.test(line)) {
        const attrs = parseHlsAttributes(line);
        if (String(attrs.TYPE || '').toUpperCase() === 'SUBTITLES' && attrs.URI) {
          hasSubtitleMedia = true;
          const target = absoluteUrl(attrs.URI, url);
          if (target) targets.add(target);
        }
      }
    }

    // If this is already a subtitle media playlist, follow its VTT/TTML segment URIs. This is
    // intentionally conservative: we do not attempt to decode fragmented MP4 subtitle samples.
    if (!hasSubtitleMedia && /#EXTINF:/i.test(text)) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (DIRECT_HINT.test(trimmed) || /\.(?:vtt|ttml|dfxp|srt)(?:$|[?#])/i.test(trimmed)) {
          const target = absoluteUrl(trimmed, url);
          if (target) targets.add(target);
        }
      }
    }

    for (const target of [...targets].slice(0, 24)) queueUrl(target, depth + 1, true);
  }

  async function processMpd(url, text, depth) {
    let doc;
    try { doc = new DOMParser().parseFromString(String(text || ''), 'application/xml'); } catch (_) { return; }
    if (!doc || doc.querySelector('parsererror')) return;
    const sets = [...doc.getElementsByTagName('*')].filter(node => String(node.localName || '').toLowerCase() === 'adaptationset');
    for (const set of sets) {
      const descriptor = [set.getAttribute('contentType'), set.getAttribute('mimeType'), set.getAttribute('codecs'), set.getAttribute('lang')].join(' ');
      if (!/(?:text|subtitle|caption|vtt|ttml|stpp|wvtt)/i.test(descriptor)) continue;
      const reps = [...set.getElementsByTagName('*')].filter(node => String(node.localName || '').toLowerCase() === 'representation');
      const containers = reps.length ? reps : [set];
      for (const container of containers) {
        const base = [...container.children].find(node => String(node.localName || '').toLowerCase() === 'baseurl');
        if (base?.textContent?.trim()) {
          const target = absoluteUrl(base.textContent.trim(), url);
          if (target) queueUrl(target, depth + 1, true);
        }
      }
    }
  }

  async function processResource(requestedUrl, result, depth = 0) {
    if (!result?.text) return;
    const finalUrl = result.url || requestedUrl;
    const contentType = result.contentType || '';
    const text = result.text;

    if (looksLikeTimedSubtitle(text, contentType, finalUrl)) {
      emit(finalUrl, contentType, text, formatHint(finalUrl, contentType, text));
      return;
    }

    if (/^#EXTM3U/m.test(text) || /mpegurl|\.m3u8/i.test(`${contentType} ${finalUrl}`)) {
      await processHls(finalUrl, text, depth);
      return;
    }

    if (/<(?:[a-z0-9_.-]+:)?MPD(?:\s|>)/i.test(text) || /dash\+xml|\.mpd/i.test(`${contentType} ${finalUrl}`)) {
      await processMpd(finalUrl, text, depth);
    }

    if (depth >= 2) return;
    for (const child of extractSubtitleUrlsFromText(text, finalUrl, contentType).slice(0, 24)) {
      queueUrl(child, depth + 1, true);
    }
  }

  async function queueUrl(rawUrl, depth = 0, force = false) {
    syncSession();
    if (seenUrls.size >= MAX_URLS_PER_SESSION) return;
    const url = absoluteUrl(rawUrl);
    if (!url || queuedUrls.has(url) || seenUrls.has(url)) return;
    if (!force && !DIRECT_HINT.test(url) && !MANIFEST_HINT.test(url) && !METADATA_HINT.test(url)) return;
    if (/\.(?:js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|mp4|m4a|mp3|aac)(?:$|[?#])/i.test(url)) return;
    queuedUrls.add(url);
    try {
      const result = await fetchResource(url);
      seenUrls.add(url);
      if (result) await processResource(url, result, depth);
    } finally {
      queuedUrls.delete(url);
    }
  }

  function collectInlineCandidates() {
    const found = new Set();
    try {
      for (const el of document.querySelectorAll('track[src], source[src], link[href]')) {
        const raw = el.getAttribute('src') || el.getAttribute('href') || '';
        if (DIRECT_HINT.test(raw) || MANIFEST_HINT.test(raw)) {
          const u = absoluteUrl(raw);
          if (u) found.add(u);
        }
      }
      for (const script of document.querySelectorAll('script:not([src])')) {
        const text = script.textContent || '';
        if (!text || text.length > 2 * 1024 * 1024 || !SUBTITLE_KEY_HINT.test(text)) continue;
        for (const u of extractSubtitleUrlsFromText(text, location.href, script.type || '')) found.add(u);
      }
    } catch (_) {}
    return [...found];
  }

  function scanResources() {
    syncSession();
    const urls = new Set(collectInlineCandidates());
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (const entry of entries) {
        const url = String(entry?.name || '');
        if (!url) continue;
        const initiator = String(entry?.initiatorType || '').toLowerCase();
        const likely = DIRECT_HINT.test(url) || MANIFEST_HINT.test(url)
          || ((initiator === 'fetch' || initiator === 'xmlhttprequest') && METADATA_HINT.test(url));
        if (likely) urls.add(url);
      }
    } catch (_) {}

    for (const url of [...urls].slice(0, 40)) queueUrl(url, 0, false);
    scanPasses += 1;
  }

  try {
    window.addEventListener('message', event => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      // The existing MAIN-world probe can hand us already-authorized player metadata responses.
      // This is important for APIs that require transient/custom request headers: we can inspect
      // the response the player actually received instead of trying to recreate its request.
      if (data.source === 'opensub-subtitle-metadata' && data.payload?.text) {
        const payload = data.payload;
        processResource(payload.url || location.href, {
          ok: true,
          url: payload.url || location.href,
          contentType: payload.contentType || '',
          text: payload.text
        }, 0).catch(() => {});
        return;
      }

      if (data.source !== 'opensub-network-probe-control' || data.type !== 'opensub-replay-current-captions') return;
      syncSession();
      for (const payload of recentPayloads.slice().reverse()) {
        try { window.postMessage({ source: 'opensub-network-probe', payload }, '*'); } catch (_) {}
      }
      // Popup refresh is also a useful time to inspect performance/API resources that were not
      // obviously subtitle-related when the page initially loaded.
      scanResources();
    });
  } catch (_) {}

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'opensub-subtitle-discovery-status') return;
      sendResponse({
        ok: true,
        frameUrl: location.href,
        sessionKey: syncSession(),
        scanPasses,
        seenUrlCount: seenUrls.size,
        queuedUrlCount: queuedUrls.size,
        recentPayloads: recentPayloads.map(item => ({
          url: item.url || '',
          contentType: item.contentType || '',
          format: item.format || '',
          via: item.via || '',
          size: String(item.text || '').length,
          capturedAt: item.capturedAt || 0,
          textPreview: String(item.text || '').slice(0, 500)
        }))
      });
    });
  } catch (_) {}

  // Scan a few times during player startup, then at a low steady cadence for SPA/player changes.
  setTimeout(scanResources, 700);
  setTimeout(scanResources, 1800);
  setTimeout(scanResources, 4200);
  scanTimer = setInterval(() => {
    scanResources();
    if (scanPasses > 120 && scanTimer) {
      clearInterval(scanTimer);
      scanTimer = 0;
    }
  }, 5000);
})();

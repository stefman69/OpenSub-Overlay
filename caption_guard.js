(() => {
  'use strict';

  // Universal source-caption echo guard.
  //
  // OpenSub's managed stack redraws the source subtitle underneath the translation. Players
  // may independently render the same source through a native TextTrack, a Shaka renderer,
  // a DOM caption layer, or a network-loaded SRT/VTT renderer. This guard is deliberately
  // source-agnostic: it uses the active source cue saved in OpenSub as the proof of identity,
  // then suppresses only a DOM renderer that displays that exact cue text.
  //
  // This lives outside content.js so the known-good Hulu/YouTube renderer remains untouched.
  const LIBRARY_KEY = 'openSubLibrary';
  const GLOBAL_KEY = 'openSubGlobal';

  function isExtensionContextInvalid(error) {
    const message = String(error?.message || error || '');
    return /extension context invalidated|context invalidated/i.test(message);
  }

  async function safeStorageGet(keys) {
    if (!globalThis.chrome?.runtime?.id || !chrome.storage?.local) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      if (isExtensionContextInvalid(error)) return {};
      throw error;
    }
  }
  const STYLE_ID = 'opensub-source-echo-guard-style';
  const HIDDEN_CLASS = 'opensub-source-echo-guard-hidden';
  const NATIVE_STYLE_ID = 'opensub-source-echo-native-style';
  const NATIVE_CLASS = 'opensub-source-echo-native-suppress';
  const HEURISTIC_MIN_POLLS = 5;
  const HEURISTIC_STALE_MS = 5000;
  const POLL_MS = 180;
  const CONTEXT_MS = 850;
  const TIME_EPSILON = 0.12;

  const ROOT_SELECTOR = [
    '[class*="caption" i]',
    '[class*="subtitle" i]',
    '[id*="caption" i]',
    '[id*="subtitle" i]',
    '[data-testid*="caption" i]',
    '[data-testid*="subtitle" i]',
    '[class*="texttrack" i]',
    '[class*="text-track" i]',
    '[id*="texttrack" i]',
    '[id*="text-track" i]',
    '.shaka-text-container',
    '[aria-live]',
    '[role="status"]'
  ].join(', ');

  const SEMANTIC_RE = /(?:caption|subtitle|closed.?caption|text.?track|shaka.?text|\bcc\b)/i;
  const CAPTION_UI_RE = /(?:caption|subtitle).{0,24}(?:menu|option|setting|preference|language|control|button|selector|list)|(?:menu|option|setting|preference|language|control|button|selector|list).{0,24}(?:caption|subtitle)|captions?-option-list|subtitles?-option-list/i;
  const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="listbox"], [role="option"], [role="radio"], [role="switch"], [role="checkbox"], [role="slider"], [role="tab"]';

  let pageKey = '';
  let entry = null;
  let globalSettings = { enabled: true, hideOriginalCaptions: false };
  let sourceCues = [];
  let contextBusy = false;
  let syncQueued = false;
  let lastActiveText = '';
  let lastVideoTime = 0;

  const hiddenNodes = new Set();
  const rendererSelectors = new Set();
  const nativeSuppressedVideos = new Set();
  const heuristicRendererState = new Map();

  const stats = {
    polls: 0,
    pageChanges: 0,
    exactMatches: 0,
    rendererLocks: 0,
    hiddenNodes: 0,
    rendererSelectors: '',
    lastActiveText: '',
    lastMatchText: '',
    lastMatchSelector: '',
    lastReason: '',
    nativeCueSuppression: false,
    heuristicCandidates: 0,
    heuristicLocks: 0,
    heuristicLastSelector: '',
    heuristicLastDescriptor: ''
  };

  function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      u.hash = '';
      return u.href;
    } catch (_) {
      return String(raw || '').split('#')[0];
    }
  }

  function cleanText(text) {
    const holder = document.createElement('textarea');
    holder.innerHTML = String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
    return holder.value
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizedText(text) {
    return cleanText(text).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function parseTimestamp(value) {
    const text = String(value || '').trim().replace(',', '.');
    let m = text.match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,3})$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4].padEnd(3, '0')}`);
    m = text.match(/^(\d{1,2}):(\d{2})\.(\d{1,3})$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3].padEnd(3, '0')}`);
    return null;
  }

  function parseSrt(text) {
    const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const out = [];
    for (const block of normalized.split(/\n{2,}/)) {
      const lines = block.split('\n');
      const timeIndex = lines.findIndex(line => line.includes('-->'));
      if (timeIndex < 0) continue;
      const timing = lines[timeIndex].match(/\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})/);
      if (!timing) continue;
      const start = parseTimestamp(timing[1]);
      const end = parseTimestamp(timing[2]);
      if (start === null || end === null || end < start) continue;
      const cueText = cleanText(lines.slice(timeIndex + 1).join('\n'));
      if (cueText) out.push({ start, end, text: cueText });
    }
    return out;
  }

  async function getTopContext() {
    try { return await chrome.runtime.sendMessage({ type: 'opensub-context' }); }
    catch (_) { return { tabUrl: location.href }; }
  }

  function isOpenSubRelated(el) {
    if (!(el instanceof Element)) return true;
    const overlay = document.getElementById('opensub-overlay-root');
    if (el.id?.startsWith('opensub-') || el.closest?.('#opensub-overlay-root')) return true;
    if (overlay && (el === overlay || el.contains(overlay))) return true;
    return false;
  }

  function cssEscape(value) {
    try { return CSS.escape(String(value || '')); }
    catch (_) { return String(value || '').replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`); }
  }

  function ensureNativeCueStyle() {
    let style = document.getElementById(NATIVE_STYLE_ID);
    if (style) return style;
    style = document.createElement('style');
    style.id = NATIVE_STYLE_ID;
    style.textContent = `
video.${NATIVE_CLASS}::cue {
  opacity: 0 !important;
  visibility: hidden !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  background: transparent !important;
  background-color: transparent !important;
  outline-color: transparent !important;
}
`;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function clearNativeCueSuppression() {
    for (const video of [...nativeSuppressedVideos]) {
      try { video.classList.remove(NATIVE_CLASS); } catch (_) {}
      nativeSuppressedVideos.delete(video);
    }
    stats.nativeCueSuppression = false;
  }

  function syncNativeCueSuppression(video, shouldSuppress) {
    for (const oldVideo of [...nativeSuppressedVideos]) {
      if (!oldVideo?.isConnected || oldVideo !== video || !shouldSuppress) {
        try { oldVideo.classList.remove(NATIVE_CLASS); } catch (_) {}
        nativeSuppressedVideos.delete(oldVideo);
      }
    }
    if (!video || !shouldSuppress) {
      stats.nativeCueSuppression = false;
      return;
    }

    // Do not hide OpenSub's own native fallback when a site fullscreens the bare <video>.
    // Those tracks are labelled by content.js and are only used when the DOM overlay cannot
    // participate in fullscreen. In normal player/container fullscreen there is no showing
    // OpenSub TextTrack, so native site cues can safely be made transparent here.
    let openSubNativeShowing = false;
    try {
      openSubNativeShowing = [...(video.textTracks || [])].some(track =>
        /^OpenSub(?: Overlay| Live Translation)?$/i.test(String(track.label || '')) && track.mode === 'showing'
      );
    } catch (_) {}
    if (openSubNativeShowing) {
      try { video.classList.remove(NATIVE_CLASS); } catch (_) {}
      nativeSuppressedVideos.delete(video);
      stats.nativeCueSuppression = false;
      return;
    }

    ensureNativeCueStyle();
    try {
      video.classList.add(NATIVE_CLASS);
      nativeSuppressedVideos.add(video);
      stats.nativeCueSuppression = true;
    } catch (_) {
      stats.nativeCueSuppression = false;
    }
  }

  function clearVisualLocks(reason = '') {
    clearNativeCueSuppression();
    heuristicRendererState.clear();
    for (const el of [...hiddenNodes]) {
      try { el.classList.remove(HIDDEN_CLASS); } catch (_) {}
      hiddenNodes.delete(el);
    }
    rendererSelectors.clear();
    try { document.getElementById(STYLE_ID)?.remove(); } catch (_) {}
    stats.rendererLocks = 0;
    stats.hiddenNodes = 0;
    stats.rendererSelectors = '';
    stats.lastMatchSelector = '';
    stats.heuristicCandidates = 0;
    stats.heuristicLastSelector = '';
    stats.heuristicLastDescriptor = '';
    if (reason) stats.lastReason = reason;
  }

  function updateLockStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!rendererSelectors.size) {
      try { style?.remove(); } catch (_) {}
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    const selectors = [...rendererSelectors];
    const lockRules = selectors.flatMap(selector => [selector, `${selector} *`]).join(',\n');
    style.textContent = `
.${HIDDEN_CLASS}, .${HIDDEN_CLASS} * {
  opacity: 0 !important;
  visibility: hidden !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  pointer-events: none !important;
}
${lockRules} {
  opacity: 0 !important;
  visibility: hidden !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  pointer-events: none !important;
}`;
    stats.rendererLocks = rendererSelectors.size;
    stats.rendererSelectors = selectors.join(' | ').slice(0, 800);
  }

  function semanticDescriptor(el) {
    if (!(el instanceof Element)) return '';
    return [
      el.id || '',
      el.className || '',
      el.getAttribute?.('data-testid') || '',
      el.getAttribute?.('data-test-id') || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('role') || ''
    ].join(' ');
  }

  function stableRendererSelector(el) {
    if (!(el instanceof Element) || containsCaptionControlUi(el)) return '';
    let node = el;
    let depth = 0;
    while (node && node !== document.documentElement && depth++ < 8) {
      if (isOpenSubRelated(node) || isCaptionControlUi(node)) return '';
      const descriptor = semanticDescriptor(node);
      if (SEMANTIC_RE.test(descriptor)) {
        const id = String(node.id || '');
        if (id && SEMANTIC_RE.test(id)) {
          const selector = `${node.tagName.toLowerCase()}#${cssEscape(id)}`;
          try {
            const count = document.querySelectorAll(selector).length;
            if (count > 0 && count <= 16) return selector;
          } catch (_) {}
        }
        for (const attr of ['data-testid', 'data-test-id']) {
          const value = String(node.getAttribute?.(attr) || '');
          if (!value || !SEMANTIC_RE.test(value)) continue;
          const selector = `${node.tagName.toLowerCase()}[${attr}="${String(value).replace(/"/g, '\\"')}"]`;
          try {
            const count = document.querySelectorAll(selector).length;
            if (count > 0 && count <= 16) return selector;
          } catch (_) {}
        }
        const classes = [...(node.classList || [])]
          .filter(name => SEMANTIC_RE.test(name) && !/^opensub-/i.test(name))
          .sort((a, b) => a.length - b.length);
        for (const className of classes) {
          const selector = `${node.tagName.toLowerCase()}.${cssEscape(className)}`;
          try {
            const count = document.querySelectorAll(selector).length;
            if (count > 0 && count <= 16) return selector;
          } catch (_) {}
        }
      }
      node = node.parentElement;
    }
    return '';
  }

  function addRendererLock(el) {
    const selector = stableRendererSelector(el);
    if (!selector) return false;
    if (!rendererSelectors.has(selector)) {
      rendererSelectors.add(selector);
      stats.lastMatchSelector = selector;
      updateLockStyle();
    }
    return true;
  }

  function visibleRect(el) {
    if (!(el instanceof Element)) return null;
    let style;
    try { style = getComputedStyle(el); } catch (_) { return null; }
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return null;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (_) { return null; }
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return null;
    return rect;
  }

  function intersects(a, b) {
    return Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
  }

  function bestVideo() {
    let best = null;
    let bestScore = -1;
    for (const video of document.querySelectorAll('video')) {
      let rect;
      try { rect = video.getBoundingClientRect(); } catch (_) { continue; }
      if (!rect || rect.width < 80 || rect.height < 45) continue;
      const area = rect.width * rect.height;
      const score = area + (!video.paused && !video.ended ? 1e9 : 0) + (video.readyState >= 2 ? 1e7 : 0);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
  }

  function activeSourceTexts(video) {
    if (!video || !sourceCues.length || !entry) return [];
    const t = Number(video.currentTime || 0) + Number(entry.offset || 0);
    lastVideoTime = t;
    return sourceCues
      .filter(cue => Number(cue.start) <= t + TIME_EPSILON && Number(cue.end) >= t - TIME_EPSILON)
      .map(cue => cleanText(cue.text))
      .filter(Boolean)
      .slice(0, 6);
  }

  function textMatchesActive(text, activeTexts) {
    const normalized = normalizedText(text);
    if (!normalized || !activeTexts.length) return false;
    const active = activeTexts.map(normalizedText).filter(Boolean);
    if (active.includes(normalized)) return true;
    const joined = normalizedText(active.join(' '));
    if (normalized === joined) return true;
    const reversed = normalizedText([...active].reverse().join(' '));
    if (normalized === reversed) return true;
    const parts = String(text || '').split(/\n+/).map(normalizedText).filter(Boolean).sort();
    const activeParts = active.flatMap(t => t.split(/\n+/).map(normalizedText).filter(Boolean)).sort();
    return parts.length === activeParts.length && parts.every((part, i) => part === activeParts[i]);
  }

  function candidateRoots(video) {
    const roots = [];
    let videoRect;
    try { videoRect = video?.getBoundingClientRect?.(); } catch (_) { return roots; }
    if (!videoRect) return roots;
    try {
      for (const el of document.querySelectorAll(ROOT_SELECTOR)) {
        if (!(el instanceof Element) || isOpenSubRelated(el)) continue;
        const rect = visibleRect(el);
        if (!rect || !intersects(rect, videoRect)) continue;
        roots.push(el);
      }
    } catch (_) {}
    return roots;
  }

  function captionUiDescriptor(el) {
    if (!(el instanceof Element)) return '';
    let text = semanticDescriptor(el);
    try { text += ` ${el.getAttribute('aria-haspopup') || ''} ${el.getAttribute('aria-controls') || ''}`; } catch (_) {}
    try {
      const own = cleanText(el.innerText || el.textContent || '');
      if (own && own.length <= 240) text += ` ${own}`;
    } catch (_) {}
    return text;
  }

  function isCaptionControlUi(el) {
    if (!(el instanceof Element)) return true;
    let node = el;
    let depth = 0;
    while (node && node !== document.documentElement && depth++ < 6) {
      try {
        if (node.matches(INTERACTIVE_SELECTOR)) return true;
      } catch (_) {}
      const descriptor = captionUiDescriptor(node);
      if (CAPTION_UI_RE.test(descriptor)) return true;
      if (/(?:shortcut|settings|controls?|language.?menu|volume|mute|play|pause|seek|scrub|progress|tooltip|metadata|episode.?title|program.?title|content.?title|tile.?subtitle|tile.?title|carousel)/i.test(descriptor)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function containsCaptionControlUi(el) {
    if (!(el instanceof Element)) return true;
    if (isCaptionControlUi(el)) return true;
    let nodes = [];
    try { nodes = [...el.querySelectorAll(INTERACTIVE_SELECTOR)].slice(0, 40); } catch (_) {}
    for (const node of nodes) {
      const d = captionUiDescriptor(node);
      if (CAPTION_UI_RE.test(d) || /(?:captions?|subtitles?|closed.?captions?|\bcc\b)/i.test(d)) return true;
    }
    return false;
  }

  function looksInteractiveOrMetadata(el) {
    if (!(el instanceof Element)) return true;
    if (isCaptionControlUi(el)) return true;
    const descriptor = semanticDescriptor(el);
    return /(?:shortcut|settings|controls?|language.?menu|volume|mute|play|pause|seek|scrub|progress|tooltip|metadata|episode.?title|program.?title|content.?title|tile.?subtitle|tile.?title|carousel)/i.test(descriptor);
  }

  function rendererGeometryScore(rect, videoRect) {
    if (!rect || !videoRect || !intersects(rect, videoRect)) return -Infinity;
    const vw = Math.max(1, videoRect.width);
    const vh = Math.max(1, videoRect.height);
    const overlapLeft = Math.max(rect.left, videoRect.left);
    const overlapRight = Math.min(rect.right, videoRect.right);
    const overlapTop = Math.max(rect.top, videoRect.top);
    const overlapBottom = Math.min(rect.bottom, videoRect.bottom);
    const overlapW = Math.max(0, overlapRight - overlapLeft);
    const overlapH = Math.max(0, overlapBottom - overlapTop);
    const overlapArea = overlapW * overlapH;
    if (overlapArea < 100) return -Infinity;
    const areaRatio = overlapArea / Math.max(1, vw * vh);
    const widthRatio = overlapW / vw;
    const heightRatio = overlapH / vh;
    const centerY = (Math.max(rect.top, videoRect.top) + Math.min(rect.bottom, videoRect.bottom)) / 2;
    const yRatio = (centerY - videoRect.top) / vh;

    // Caption renderers tend to be either a full-player overlay or a band/box within the video.
    // Give both shapes credit while rejecting tiny CC buttons and off-player metadata.
    let score = 0;
    if (widthRatio >= 0.55) score += 4;
    else if (widthRatio >= 0.18) score += 2;
    if (areaRatio >= 0.45) score += 4;
    else if (areaRatio >= 0.05) score += 2;
    if (heightRatio >= 0.08) score += 1;
    if (yRatio >= 0.35 && yRatio <= 1.08) score += 2;
    if (widthRatio < 0.08 && heightRatio < 0.08) score -= 8;
    return score;
  }

  function strongRendererDescriptor(el) {
    const descriptor = semanticDescriptor(el);
    if (!descriptor) return '';
    if (!/(?:closed.?caption|captions?|subtitles?|subtitle.?layer|caption.?layer|subtitle.?render|caption.?render|dynamic.?subtitles|text.?track|shaka.?text|timed.?text)/i.test(descriptor)) return '';
    return descriptor;
  }

  function semanticRendererCandidates(video) {
    const out = [];
    if (!video) return out;
    let videoRect;
    try { videoRect = video.getBoundingClientRect(); } catch (_) { return out; }
    let nodes = [];
    try { nodes = [...document.querySelectorAll(ROOT_SELECTOR)]; } catch (_) {}
    for (const el of nodes) {
      if (!(el instanceof Element) || isOpenSubRelated(el) || looksInteractiveOrMetadata(el) || containsCaptionControlUi(el)) continue;
      const descriptor = strongRendererDescriptor(el);
      if (!descriptor) continue;
      const rect = visibleRect(el);
      const geometry = rendererGeometryScore(rect, videoRect);
      if (!Number.isFinite(geometry) || geometry < 5) continue;
      const selector = stableRendererSelector(el);
      if (!selector) continue;
      out.push({ el, selector, descriptor, geometry, area: rect.width * rect.height });
    }
    out.sort((a, b) => b.geometry - a.geometry || b.area - a.area);
    return out;
  }

  function learnSemanticRenderer(video, activeTexts) {
    if (!video || !activeTexts.length || rendererSelectors.size) return;
    const now = Date.now();
    const fingerprint = activeTexts.map(normalizedText).filter(Boolean).join(' | ');
    if (!fingerprint) return;
    const candidates = semanticRendererCandidates(video).slice(0, 12);
    stats.heuristicCandidates = candidates.length;

    const seen = new Set();
    for (const candidate of candidates) {
      seen.add(candidate.selector);
      let state = heuristicRendererState.get(candidate.selector);
      if (!state) state = { polls: 0, activeChanges: 0, lastFingerprint: '', lastSeenAt: 0, descriptor: '' };
      state.polls++;
      state.lastSeenAt = now;
      state.descriptor = candidate.descriptor;
      if (state.lastFingerprint && state.lastFingerprint !== fingerprint) state.activeChanges++;
      state.lastFingerprint = fingerprint;
      heuristicRendererState.set(candidate.selector, state);

      // A strongly named caption renderer that persists while real OpenSub source cues are
      // active is sufficient evidence when the player's rendered text is inaccessible to
      // textContent (native/closed-shadow/canvas-backed player implementations). Requiring
      // several polls prevents one transient settings/CC control from being promoted.
      if (state.polls >= HEURISTIC_MIN_POLLS || state.activeChanges >= 2) {
        if (rendererSelectors.has(candidate.selector)) continue;
        rendererSelectors.add(candidate.selector);
        stats.heuristicLocks++;
        stats.heuristicLastSelector = candidate.selector;
        stats.heuristicLastDescriptor = candidate.descriptor.slice(0, 500);
        stats.lastMatchSelector = candidate.selector;
        stats.lastReason = 'semantic-renderer-lock';
        updateLockStyle();
        break;
      }
    }

    for (const [selector, state] of [...heuristicRendererState]) {
      if (now - Number(state.lastSeenAt || 0) > HEURISTIC_STALE_MS || (!seen.has(selector) && now - Number(state.lastSeenAt || 0) > 1200)) {
        heuristicRendererState.delete(selector);
      }
    }
  }

  function suppressMatchingEcho(video, activeTexts) {
    if (!video || !activeTexts.length) return;
    const videoRect = video.getBoundingClientRect();
    const candidates = new Set();
    for (const root of candidateRoots(video)) {
      candidates.add(root);
      try {
        for (const child of root.querySelectorAll('div, span, p, section, cue')) candidates.add(child);
      } catch (_) {}
    }

    const matches = [];
    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || isOpenSubRelated(el) || isCaptionControlUi(el)) continue;
      const rect = visibleRect(el);
      if (!rect || !intersects(rect, videoRect)) continue;
      // Allow a large semantic caption layer as a root, but only exact-text descendants are
      // considered proof. This catches Tubi-style full-player dynamicSubtitles wrappers while
      // avoiding generic player/control containers.
      const text = cleanText(el.innerText || el.textContent || '');
      if (!textMatchesActive(text, activeTexts)) continue;
      matches.push({ el, area: rect.width * rect.height, text });
    }
    if (!matches.length) {
      learnSemanticRenderer(video, activeTexts);
      return;
    }

    matches.sort((a, b) => a.area - b.area);
    const chosen = [];
    for (const match of matches) {
      if (chosen.some(item => match.el.contains(item.el))) continue;
      chosen.push(match);
    }

    for (const { el, text } of chosen.slice(0, 8)) {
      if (isOpenSubRelated(el)) continue;
      const locked = addRendererLock(el);
      if (!locked) {
        try {
          el.classList.add(HIDDEN_CLASS);
          hiddenNodes.add(el);
        } catch (_) {}
      }
      stats.exactMatches++;
      stats.lastMatchText = cleanText(text).slice(0, 300);
    }
    stats.hiddenNodes = hiddenNodes.size;
  }

  async function loadPageState(newPageKey, reason = '') {
    const nextKey = normalizeUrl(newPageKey || '');
    if (nextKey !== pageKey) {
      clearVisualLocks(reason || 'page-changed');
      if (pageKey) stats.pageChanges++;
      pageKey = nextKey;
    }
    if (!pageKey) {
      entry = null;
      sourceCues = [];
      return;
    }
    try {
      const data = await safeStorageGet([LIBRARY_KEY, GLOBAL_KEY]);
      globalSettings = { enabled: true, hideOriginalCaptions: false, ...(data[GLOBAL_KEY] || {}) };
      const candidate = (data[LIBRARY_KEY] || {})[pageKey] || null;
      entry = candidate && candidate.enabled !== false ? candidate : null;
      sourceCues = entry?.sourceText ? parseSrt(entry.sourceText) : [];
      if (!globalSettings.enabled || !entry || !sourceCues.length) clearVisualLocks('no-active-entry');
    } catch (_) {}
  }

  async function refreshTopContext(reason = '') {
    if (contextBusy) return;
    contextBusy = true;
    try {
      const context = await getTopContext();
      const next = normalizeUrl(context?.tabUrl || location.href);
      if (next !== pageKey || reason) await loadPageState(next, reason || 'context-refresh');
    } finally {
      contextBusy = false;
    }
  }

  function sync() {
    stats.polls++;
    for (const el of [...hiddenNodes]) {
      if (!el?.isConnected) hiddenNodes.delete(el);
      else if (isOpenSubRelated(el)) {
        try { el.classList.remove(HIDDEN_CLASS); } catch (_) {}
        hiddenNodes.delete(el);
      }
    }
    stats.hiddenNodes = hiddenNodes.size;

    if (!globalSettings.enabled || !entry || entry.enabled === false || !sourceCues.length) {
      clearNativeCueSuppression();
      return;
    }
    const video = bestVideo();
    if (!video) {
      clearNativeCueSuppression();
      return;
    }
    const active = activeSourceTexts(video);
    lastActiveText = active.join(' | ').slice(0, 500);
    stats.lastActiveText = lastActiveText;

    // Never manipulate the website/player's CC controls. Passive suppression may hide a
    // duplicate source renderer when it can identify one safely; otherwise the user can turn
    // the site's captions off manually without OpenSub changing player state behind them.

    // Native ::cue suppression is source-agnostic and does not depend on text matching.
    // It covers players that surface captions through browser cue rendering but expose little
    // or no useful DOM/TextTrack metadata to the extension.
    syncNativeCueSuppression(video, Boolean(active.length));

    if (!active.length) return;
    suppressMatchingEcho(video, active);
    if (!rendererSelectors.size) learnSemanticRenderer(video, active);
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      sync();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[LIBRARY_KEY] || changes[GLOBAL_KEY]) refreshTopContext('storage-changed').then(queueSync).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'opensub-caption-guard-refresh') {
      refreshTopContext('manual-refresh').then(() => {
        queueSync();
        sendResponse({ ok: true });
      }).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === 'opensub-caption-guard-status') {
      const video = bestVideo();
      const active = video ? activeSourceTexts(video) : [];
      sendResponse({
        ok: true,
        pageKey,
        frameUrl: normalizeUrl(location.href),
        enabled: Boolean(globalSettings.enabled),
        hasEntry: Boolean(entry),
        entryDynamicSource: entry?.dynamicSource || '',
        sourceCueCount: sourceCues.length,
        currentTime: Number(video?.currentTime || 0),
        effectiveTime: Number(lastVideoTime || 0),
        activeSourceTexts: active,
        nativeSuppressedVideoCount: nativeSuppressedVideos.size,
        playerCaptionControlPolicy: 'manual-only',
        heuristicCandidateStates: [...heuristicRendererState.entries()].slice(0, 12).map(([selector, state]) => ({
          selector,
          polls: state.polls,
          activeChanges: state.activeChanges,
          descriptor: String(state.descriptor || '').slice(0, 300)
        })),
        stats: { ...stats }
      });
      return;
    }
  });

  try {
    const observer = new MutationObserver(() => queueSync());
    observer.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true });
  } catch (_) {}

  setInterval(sync, POLL_MS);
  setInterval(() => refreshTopContext().catch(() => {}), CONTEXT_MS);
  refreshTopContext('initial').then(queueSync).catch(() => {});
})();

(() => {
  'use strict';

  const LIBRARY_KEY = 'openSubLibrary';
  const GLOBAL_KEY = 'openSubGlobal';
  const DEFAULT_GLOBAL = { enabled: true, subtitleSize: 'medium', hideOriginalCaptions: false };
  const SUBTITLE_SIZE_FACTORS = { xsmall: 0.60, small: 0.72, medium: 0.84, large: 0.96, xlarge: 1.10 };
  const LIVE_HOLD_MS = 900;
  const GENERIC_CAPTION_MUTATION_MS = 2600;
  const NETWORK_LIMIT = 24;
  const CAPTION_SELECTOR = [
    '[class*="caption" i]', '[id*="caption" i]', '[class*="subtitle" i]', '[id*="subtitle" i]',
    '[data-testid*="caption" i]', '[data-testid*="subtitle" i]', '[aria-label*="caption" i]',
    '[aria-label*="subtitle" i]', '[aria-live="polite"]', '[aria-live="assertive"]'
  ].join(',');

  let topPageUrl = '';
  let entry = null;
  let cues = [];
  let activeVideo = null;
  let lastCueIndex = -2;
  let lastContextCheck = 0;
  let lastGeometry = '';
  let rafId = 0;
  let nativeTrack = null;
  let nativeTrackVideo = null;
  let liveNativeTrack = null;
  let liveNativeTrackVideo = null;
  let liveConfig = null;
  let liveTranslatedText = '';
  let liveOriginalText = '';
  let livePendingText = '';
  let liveLastSeenAt = 0;
  let liveBaselineText = '';
  let liveBaselineSignature = '';
  let liveBaselineStrong = false;
  let liveTrustedCaptionSignature = '';
  let liveTrustedCaptionElement = null;
  let liveSawFreshCaption = false;
  let lastDomProbeAt = 0;
  let observedDomCaption = '';
  let observedDomCaptionAt = 0;
  const networkCandidates = [];
  let currentGlobal = { ...DEFAULT_GLOBAL };
  const domMutationAt = new WeakMap();
  const captionSignatureState = new Map();
  const originalTrackModes = new WeakMap();
  const hiddenOriginalCaptionElements = new Set();

  function subtitleSizeFactor() {
    return SUBTITLE_SIZE_FACTORS[currentGlobal.subtitleSize] || SUBTITLE_SIZE_FACTORS.medium;
  }

  function markDomMutation(node, when = Date.now()) {
    let el = node instanceof Element ? node : node?.parentElement;
    let depth = 0;
    while (el && depth++ < 6) {
      domMutationAt.set(el, when);
      el = el.parentElement;
    }
  }

  try {
    const captionMutationObserver = new MutationObserver(records => {
      const when = Date.now();
      for (const record of records) {
        markDomMutation(record.target, when);
        for (const node of record.addedNodes || []) markDomMutation(node, when);
      }
    });
    captionMutationObserver.observe(document, { subtree: true, childList: true, characterData: true });
  } catch (_) {}

  function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      u.hash = '';
      return u.href;
    } catch (_) {
      return String(raw || '').split('#')[0];
    }
  }

  function parseTimestamp(value) {
    const text = String(value || '').trim().replace(',', '.');
    let m = text.match(/^(\d+):(\d{2}):(\d{2})\.(\d{3})$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    m = text.match(/^(\d{1,2}):(\d{2})\.(\d{3})$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
    return null;
  }

  function cleanText(text) {
    const holder = document.createElement('textarea');
    holder.innerHTML = String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
    return holder.value.trim();
  }

  function parseSubtitleText(input) {
    const normalized = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n{2,}/);
    const out = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(line => line.trimEnd());
      const timeIndex = lines.findIndex(line => line.includes('-->'));
      if (timeIndex < 0) continue;
      const timing = lines[timeIndex].match(/\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{3})/);
      if (!timing) continue;
      const start = parseTimestamp(timing[1]);
      const end = parseTimestamp(timing[2]);
      if (start === null || end === null || end < start) continue;
      const text = cleanText(lines.slice(timeIndex + 1).join('\n'));
      if (!text || /^NOTE(?:\s|$)/i.test(text)) continue;
      out.push({ start, end, text });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  function visibleRect(element) {
    if (!(element instanceof Element)) return null;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) < 0.05) return null;
    const r = element.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return r;
  }

  function bestVideo() {
    let best = null;
    let bestScore = 0;
    for (const video of document.querySelectorAll('video')) {
      const r = visibleRect(video);
      if (!r || r.width < 120 || r.height < 70) continue;
      const visibleW = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
      const visibleH = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
      const area = visibleW * visibleH;
      const playingBonus = !video.paused && !video.ended ? 1.45 : 1;
      const score = area * playingBonus;
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  function getDocumentHost() {
    return document.documentElement || document.body || null;
  }

  function fullscreenWrapperFor(video) {
    const fs = document.fullscreenElement;
    if (!fs || !video) return null;
    if (fs === video) return video;
    if (fs.contains?.(video)) return fs;
    return null;
  }

  function ensureOverlay() {
    let root = document.getElementById('opensub-overlay-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'opensub-overlay-root';
      const text = document.createElement('span');
      text.id = 'opensub-overlay-text';
      root.appendChild(text);


      getDocumentHost()?.appendChild(root);
    }
    return root;
  }

  function ensureStatus() {
    let el = document.getElementById('opensub-overlay-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'opensub-overlay-status';
      getDocumentHost()?.appendChild(el);
    }
    return el;
  }

  function moveUiToHost(host) {
    if (!host) return;
    const root = ensureOverlay();
    const status = ensureStatus();
    try { if (root.parentNode !== host) host.appendChild(root); } catch (_) {}
    try { if (status.parentNode !== host) host.appendChild(status); } catch (_) {}
  }

  function showStatus(text) {
    const el = ensureStatus();
    el.textContent = text;
    el.classList.add('opensub-show');
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => el.classList.remove('opensub-show'), 2600);
  }

  function hideOverlay() {
    const root = document.getElementById('opensub-overlay-root');
    if (root) root.style.display = 'none';
  }

  function findCueIndex(time) {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cue = cues[mid];
      if (time < cue.start) hi = mid - 1;
      else if (time > cue.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function clearNativeFallback() {
    if (nativeTrack) {
      try { nativeTrack.mode = 'disabled'; } catch (_) {}
    }
    if (nativeTrackVideo?.dataset) delete nativeTrackVideo.dataset.opensubSize;
    nativeTrack = null;
    nativeTrackVideo = null;
  }

  function installNativeFallback(video) {
    if (!video || !entry || !cues.length || typeof VTTCue === 'undefined') return;
    if (nativeTrack && nativeTrackVideo === video) {
      nativeTrack.mode = 'showing';
      return;
    }
    clearNativeFallback();
    try {
      video.dataset.opensubSize = currentGlobal.subtitleSize || 'medium';
      nativeTrack = video.addTextTrack('subtitles', 'OpenSub Overlay', entry.targetLanguage || entry.sourceLanguage || '');
      nativeTrack.mode = 'showing';
      for (const cue of cues) {
        const c = new VTTCue(Math.max(0, cue.start - Number(entry.offset || 0)), Math.max(0.01, cue.end - Number(entry.offset || 0)), cue.text);
        nativeTrack.addCue(c);
      }
      nativeTrackVideo = video;
    } catch (_) {
      clearNativeFallback();
    }
  }

  function clearLiveNativeFallback() {
    if (liveNativeTrack) {
      try { liveNativeTrack.mode = 'disabled'; } catch (_) {}
    }
    if (liveNativeTrackVideo?.dataset) delete liveNativeTrackVideo.dataset.opensubSize;
    liveNativeTrack = null;
    liveNativeTrackVideo = null;
  }

  function showLiveNativeCue(video, text) {
    if (!video || !text || typeof VTTCue === 'undefined') return;
    try {
      if (!liveNativeTrack || liveNativeTrackVideo !== video) {
        clearLiveNativeFallback();
        video.dataset.opensubSize = currentGlobal.subtitleSize || 'medium';
        liveNativeTrack = video.addTextTrack('subtitles', 'OpenSub Live Translation', liveConfig?.targetLanguage || '');
        liveNativeTrack.mode = 'showing';
        liveNativeTrackVideo = video;
      }
      for (const cue of [...(liveNativeTrack.cues || [])]) {
        try { liveNativeTrack.removeCue(cue); } catch (_) {}
      }
      const now = Number(video.currentTime || 0);
      liveNativeTrack.addCue(new VTTCue(Math.max(0, now - 0.25), now + 8, text));
      liveNativeTrack.mode = 'showing';
    } catch (_) {}
  }

  function geometryFor(video) {
    const r = video.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
  }

  function restoreOriginalCaptionVisibility() {
    for (const video of document.querySelectorAll('video')) {
      for (const track of [...(video.textTracks || [])]) {
        if (!originalTrackModes.has(track)) continue;
        try { track.mode = originalTrackModes.get(track); } catch (_) {}
        originalTrackModes.delete(track);
      }
    }
    for (const el of [...hiddenOriginalCaptionElements]) {
      try { el.classList.remove('opensub-hide-original-caption'); } catch (_) {}
      hiddenOriginalCaptionElements.delete(el);
    }
  }

  function concealOriginalCaptionElement(el) {
    if (!(el instanceof Element)) return;
    try {
      el.classList.add('opensub-hide-original-caption');
      hiddenOriginalCaptionElements.add(el);
    } catch (_) {}
  }

  function syncNativeOriginalCaptionVisibility(video, active) {
    if (!video) return;
    const shouldHide = Boolean(active && currentGlobal.hideOriginalCaptions);
    for (const track of [...(video.textTracks || [])]) {
      if (track === nativeTrack || track === liveNativeTrack) continue;
      const isCaptionTrack = /captions|subtitles/i.test(String(track.kind || ''));
      if (!isCaptionTrack) continue;
      if (shouldHide) {
        if (!originalTrackModes.has(track)) originalTrackModes.set(track, track.mode);
        // hidden keeps cues populated/firing without drawing the site's native captions.
        try { if (track.mode === 'showing') track.mode = 'hidden'; } catch (_) {}
      } else if (originalTrackModes.has(track)) {
        try { track.mode = originalTrackModes.get(track); } catch (_) {}
        originalTrackModes.delete(track);
      }
    }
  }

  function syncDomOriginalCaptionVisibility(video, active) {
    for (const el of [...hiddenOriginalCaptionElements]) {
      if (!el?.isConnected) hiddenOriginalCaptionElements.delete(el);
    }
    const shouldHide = Boolean(active && currentGlobal.hideOriginalCaptions);
    if (!shouldHide) {
      for (const el of [...hiddenOriginalCaptionElements]) {
        try { el.classList.remove('opensub-hide-original-caption'); } catch (_) {}
        hiddenOriginalCaptionElements.delete(el);
      }
      return;
    }

    // A locked live source is the safest element to suppress because OpenSub has already
    // demonstrated that it behaves like the actual changing subtitle region.
    if (liveTrustedCaptionElement?.isConnected) concealOriginalCaptionElement(liveTrustedCaptionElement);

    // For complete-track playback, also suppress a strongly identified visible caption node.
    if (entry && cues.length && video) {
      const candidate = findVisibleCaptionCandidate(video);
      if (candidate?.strong && !looksLikeMediaMetadata(candidate.text)) concealOriginalCaptionElement(candidate.el);
    }
  }

  function textForOverlay(video) {
    if (liveConfig?.enabled && liveTranslatedText && Date.now() - liveLastSeenAt < LIVE_HOLD_MS) return liveTranslatedText;
    if (!entry || !cues.length) return '';
    const effective = Number(video.currentTime || 0) + Number(entry.offset || 0);
    const cueIndex = findCueIndex(effective);
    lastCueIndex = cueIndex;
    return cueIndex >= 0 ? cues[cueIndex].text : '';
  }

  function render() {
    rafId = requestAnimationFrame(render);
    const hasSaved = Boolean(entry && cues.length);
    const hasLiveSession = Boolean(liveConfig?.enabled);
    const hasLive = Boolean(hasLiveSession && liveTranslatedText && Date.now() - liveLastSeenAt < LIVE_HOLD_MS);
    if (!hasSaved && !hasLiveSession) {
      hideOverlay();
      clearNativeFallback();
      clearLiveNativeFallback();
      restoreOriginalCaptionVisibility();
      return;
    }

    const video = bestVideo();
    if (!video) {
      hideOverlay();
      clearNativeFallback();
      clearLiveNativeFallback();
      return;
    }
    if (video !== activeVideo) {
      activeVideo = video;
      lastCueIndex = -2;
      lastGeometry = '';
      clearNativeFallback();
      clearLiveNativeFallback();
    }

    syncNativeOriginalCaptionVisibility(video, hasSaved || hasLiveSession);
    syncDomOriginalCaptionVisibility(video, hasSaved || hasLiveSession);

    const fsHost = fullscreenWrapperFor(video);
    if (fsHost === video) {
      hideOverlay();
      if (hasLive) {
        clearNativeFallback();
        showLiveNativeCue(video, liveTranslatedText);
      } else {
        clearLiveNativeFallback();
        installNativeFallback(video);
      }
      return;
    }

    clearNativeFallback();
    clearLiveNativeFallback();
    const host = fsHost || getDocumentHost();
    moveUiToHost(host);
    const root = ensureOverlay();
    const text = root.querySelector('#opensub-overlay-text');
    const displayText = textForOverlay(video);
    // When the site's original captions are suppressed, OpenSub becomes the only
    // subtitle line, so move it down into the normal single-subtitle position.
    root.classList.toggle('opensub-single-line-position', Boolean(currentGlobal.hideOriginalCaptions));

    if (fsHost) {
      root.classList.add('opensub-in-fullscreen');
      root.style.left = '0px';
      root.style.top = '0px';
      root.style.width = '100%';
      root.style.height = '100%';
      root.style.setProperty('--opensub-font-size', `${Math.max(16, Math.min(60, innerHeight * Number(entry?.fontScale || 0.05) * subtitleSizeFactor()))}px`);
      lastGeometry = 'fullscreen';
    } else {
      root.classList.remove('opensub-in-fullscreen');
      const g = geometryFor(video);
      const r = video.getBoundingClientRect();
      if (g !== lastGeometry) {
        lastGeometry = g;
        root.style.left = `${r.left}px`;
        root.style.top = `${r.top}px`;
        root.style.width = `${r.width}px`;
        root.style.height = `${r.height}px`;
      }
      const baseSize = Math.max(13, Math.min(49, r.height * Number(entry?.fontScale || 0.045) * subtitleSizeFactor()));
      root.style.setProperty('--opensub-font-size', `${baseSize}px`);
    }

    if (displayText) {
      text.textContent = displayText;
      root.style.display = 'flex';
    } else {
      text.textContent = '';
      root.style.display = 'none';
    }
  }

  function candidateId(detail) {
    const raw = `${detail.url || ''}|${detail.format || ''}|${String(detail.text || '').slice(0, 220)}`;
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `cap-${(hash >>> 0).toString(16)}`;
  }

  function rememberNetworkCandidate(detail) {
    if (!detail?.text) return;
    const id = candidateId(detail);
    const existing = networkCandidates.find(item => item.id === id);
    const candidate = {
      id,
      url: String(detail.url || ''),
      contentType: String(detail.contentType || ''),
      format: String(detail.format || 'Timed text'),
      via: String(detail.via || ''),
      text: String(detail.text || ''),
      size: String(detail.text || '').length,
      capturedAt: Number(detail.capturedAt || Date.now())
    };
    if (existing) Object.assign(existing, candidate);
    else networkCandidates.unshift(candidate);
    networkCandidates.sort((a, b) => b.capturedAt - a.capturedAt);
    if (networkCandidates.length > NETWORK_LIMIT) networkCandidates.length = NETWORK_LIMIT;
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'opensub-network-probe') return;
    rememberNetworkCandidate(event.data.payload);
  });

  function intersects(a, b) {
    return Math.max(a.left, b.left) < Math.min(a.right, b.right) && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
  }

  function captionCandidateScore(el, rect, videoRect, text, now) {
    const attrs = `${el.id || ''} ${el.className || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('data-testid') || ''}`.toLowerCase();
    const strong = /caption|subtitle|timedtext|timed-text|cue|closed.?caption/.test(attrs);
    const ariaLive = el.hasAttribute?.('aria-live');
    const centerY = (rect.top + rect.bottom) / 2;
    const centerX = (rect.left + rect.right) / 2;
    const videoCenterX = (videoRect.left + videoRect.right) / 2;
    const relativeY = (centerY - videoRect.top) / Math.max(1, videoRect.height);
    const centered = Math.abs(centerX - videoCenterX) <= videoRect.width * 0.38;
    const mutationAt = Number(domMutationAt.get(el) || 0);
    const recentMutation = now - mutationAt <= GENERIC_CAPTION_MUTATION_MS;

    let score = 0;
    if (strong) score += 10;
    if (ariaLive) score += 1;
    if (relativeY > 0.48 && relativeY < 1.06) score += 5;
    else if (relativeY < 0.30) score -= 5;
    if (centered) score += 3;
    if (rect.width >= videoRect.width * 0.08 && rect.width <= videoRect.width * 0.98) score += 2;
    if (rect.height <= videoRect.height * 0.30) score += 2;
    if (text.length < 260) score += 2;
    if (el.children.length <= 8) score += 1;
    if (el.querySelector?.('button,a,input,select,textarea')) score -= 7;

    return { score, strong, ariaLive, relativeY, centered, recentMutation, mutationAt };
  }

  function stableElementToken(el) {
    if (!(el instanceof Element)) return '';
    const tag = String(el.tagName || '').toLowerCase();
    const id = String(el.id || '').trim();
    const testId = String(el.getAttribute?.('data-testid') || '').trim();
    const role = String(el.getAttribute?.('role') || '').trim();
    const ariaLive = String(el.getAttribute?.('aria-live') || '').trim();
    const classes = [...(el.classList || [])]
      .filter(name => name && name.length < 100)
      .slice(0, 8)
      .sort()
      .join('.');
    return `${tag}${id ? `#${id}` : ''}${classes ? `.${classes}` : ''}${testId ? `[data-testid=${testId}]` : ''}${role ? `[role=${role}]` : ''}${ariaLive ? `[aria-live=${ariaLive}]` : ''}`;
  }

  function captionElementSignature(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node !== document.body && node !== document.documentElement && depth++ < 3) {
      parts.push(stableElementToken(node));
      node = node.parentElement;
    }
    return parts.filter(Boolean).join(' > ');
  }

  function noteCaptionSignature(signature, text, now) {
    if (!signature || !text) return { changes: 0, lastChangeAt: 0, firstSeenAt: now };
    let state = captionSignatureState.get(signature);
    if (!state) {
      state = { lastText: text, changes: 0, lastChangeAt: 0, firstSeenAt: now, lastSeenAt: now };
      captionSignatureState.set(signature, state);
    } else {
      state.lastSeenAt = now;
      if (state.lastText !== text) {
        state.lastText = text;
        state.changes += 1;
        state.lastChangeAt = now;
      }
    }
    if (captionSignatureState.size > 80) {
      for (const [key, value] of captionSignatureState) {
        if (now - Number(value.lastSeenAt || 0) > 120000) captionSignatureState.delete(key);
      }
    }
    return state;
  }

  function looksLikeMediaMetadata(text) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (!compact || compact.length > 140) return false;
    return /^(?:S(?:eason)?\s*\d{1,3}\s*E(?:pisode)?\s*\d{1,4}\b|Season\s*\d{1,3}\s*[,·:–—-]?\s*Episode\s*\d{1,4}\b)/i.test(compact);
  }

  function findVisibleCaptionCandidate(video, requiredSignature = '') {
    if (!video || !document.querySelectorAll) return null;
    const vr = video.getBoundingClientRect();
    const candidates = [];
    const now = Date.now();
    let nodes = [];
    try { nodes = [...document.querySelectorAll(CAPTION_SELECTOR)]; } catch (_) { return null; }

    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.id?.startsWith('opensub-') || el.closest?.('#opensub-overlay-root')) continue;
      const tag = el.tagName;
      if (['BUTTON','INPUT','SELECT','TEXTAREA','SCRIPT','STYLE','NOSCRIPT'].includes(tag)) continue;
      const rect = visibleRect(el);
      if (!rect || !intersects(rect, vr)) continue;
      if (rect.width > vr.width * 1.20 || rect.height > vr.height * 0.48) continue;
      const text = cleanText(el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n');
      if (!text || text.length > 600) continue;

      const info = captionCandidateScore(el, rect, vr, text, now);
      const signature = captionElementSignature(el);
      if (requiredSignature && signature !== requiredSignature && el !== liveTrustedCaptionElement) continue;

      // Generic accessibility live regions are common in streaming sites and often contain
      // unrelated player/account announcements. They must mutate recently, sit where captions
      // normally appear, and must not look like episode metadata such as "S1E2 Yosemite".
      if (!info.strong) {
        if (!info.ariaLive || !info.recentMutation || !info.centered || info.relativeY < 0.45) continue;
        if (rect.width < vr.width * 0.08 || rect.height < 10) continue;
        if (looksLikeMediaMetadata(text)) continue;
      }
      if (info.score < (info.strong ? 7 : 10)) continue;

      const activity = noteCaptionSignature(signature, text, now);
      candidates.push({
        el,
        signature,
        text,
        score: info.score,
        strong: info.strong,
        ariaLive: info.ariaLive,
        recentMutation: info.recentMutation,
        mutationAt: info.mutationAt,
        changes: Number(activity.changes || 0),
        lastChangeAt: Number(activity.lastChangeAt || 0),
        area: rect.width * rect.height
      });
    }

    candidates.sort((a, b) =>
      Number(b.signature === requiredSignature) - Number(a.signature === requiredSignature) ||
      Number(b.recentMutation) - Number(a.recentMutation) ||
      Number(b.strong) - Number(a.strong) ||
      b.changes - a.changes ||
      b.score - a.score ||
      a.area - b.area ||
      a.text.length - b.text.length
    );
    if (!candidates.length) return null;
    const best = candidates[0];
    best.text = best.text.replace(/(?:^|\n)(CC|Subtitles?|Captions?)\s*(?:On|Off)?$/gim, '').trim();
    return best.text ? best : null;
  }

  function findVisibleCaptionText(video) {
    return findVisibleCaptionCandidate(video)?.text || '';
  }

  async function maybeTranslateLiveCaption(video) {
    const now = Date.now();
    if (now - lastDomProbeAt < 220) return;
    lastDomProbeAt = now;

    // Once a genuine caption source has been identified, never jump to another DOM node
    // simply because the real caption temporarily disappeared. This is the key protection
    // against stale streaming-service UI/accessibility text appearing during silence.
    let candidate = findVisibleCaptionCandidate(video, liveConfig?.enabled && liveTrustedCaptionSignature ? liveTrustedCaptionSignature : '');

    // While we are still learning the source, scan normally so the popup can report a sample.
    if (!candidate && (!liveConfig?.enabled || !liveTrustedCaptionSignature)) {
      candidate = findVisibleCaptionCandidate(video);
    }

    const text = candidate?.text || '';

    if (text) {
      observedDomCaption = text;
      observedDomCaptionAt = now;
    } else if (now - observedDomCaptionAt > LIVE_HOLD_MS) {
      observedDomCaption = '';
    }

    if (!liveConfig?.enabled) return;

    if (!text) {
      if (now - liveLastSeenAt > LIVE_HOLD_MS) {
        liveTranslatedText = '';
        liveOriginalText = '';
        livePendingText = '';
        clearLiveNativeFallback();
      }
      return;
    }

    if (!liveTrustedCaptionSignature) {
      const changedFromBaseline = !liveBaselineText || text !== liveBaselineText;
      const sameAsBaselineNode = Boolean(liveBaselineSignature && candidate?.signature === liveBaselineSignature);
      const activeHistory = Number(candidate?.changes || 0) >= 2 && now - Number(candidate?.lastChangeAt || 0) < 15000;
      const strongFreshCandidate = Boolean(candidate?.strong && candidate?.recentMutation && !looksLikeMediaMetadata(text));

      // If live mode began while a real caption was on screen, wait for that same caption
      // element to change. If it began during silence, a freshly changing strong caption node
      // may take over. Weak aria-live regions need a demonstrated history of caption-like changes.
      const canTrust = changedFromBaseline && (
        (sameAsBaselineNode && (candidate?.strong || candidate?.recentMutation)) ||
        strongFreshCandidate ||
        activeHistory
      );

      if (!canTrust) return;
      liveTrustedCaptionSignature = candidate.signature || '';
      liveTrustedCaptionElement = candidate.el || null;
      liveSawFreshCaption = true;
      if (currentGlobal.hideOriginalCaptions && liveTrustedCaptionElement) concealOriginalCaptionElement(liveTrustedCaptionElement);
    }

    // A trusted source is allowed to change its text, but not its DOM identity. If its cue
    // disappears, the overlay is cleared rather than falling through to an unrelated node.
    if (liveTrustedCaptionSignature && candidate?.signature !== liveTrustedCaptionSignature && candidate?.el !== liveTrustedCaptionElement) return;
    if (currentGlobal.hideOriginalCaptions && candidate?.el) concealOriginalCaptionElement(candidate.el);

    if (text === liveOriginalText) {
      liveLastSeenAt = now;
      return;
    }
    if (text === livePendingText) return;

    livePendingText = text;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'opensub-live-translate',
        text,
        sourceLanguage: liveConfig.sourceLanguage || 'auto',
        targetLanguage: liveConfig.targetLanguage || 'en'
      });
      if (!liveConfig?.enabled || livePendingText !== text) return;
      if (result?.ok) {
        liveOriginalText = text;
        liveTranslatedText = result.text || text;
        liveLastSeenAt = Date.now();
        if (result.sourceLanguage && liveConfig.sourceLanguage === 'auto') liveConfig.detectedLanguage = result.sourceLanguage;
      } else if (result?.error) {
        showStatus(`Live translate: ${result.error}`);
      }
    } catch (error) {
      showStatus(`Live translate: ${error.message}`);
    } finally {
      if (livePendingText === text) livePendingText = '';
    }
  }

  setInterval(() => {
    const video = bestVideo();
    if (video) maybeTranslateLiveCaption(video);
  }, 180);

  async function getTopContext() {
    try {
      return await chrome.runtime.sendMessage({ type: 'opensub-context' });
    } catch (_) {
      return { tabUrl: location.href, frameUrl: location.href, frameId: 0 };
    }
  }

  async function loadBinding({ announce = false } = {}) {
    const context = await getTopContext();
    const url = normalizeUrl(context?.tabUrl || location.href);
    topPageUrl = url;
    const data = await chrome.storage.local.get([LIBRARY_KEY, GLOBAL_KEY]);
    const global = { ...DEFAULT_GLOBAL, ...(data[GLOBAL_KEY] || {}) };
    currentGlobal = global;
    const library = data[LIBRARY_KEY] || {};
    const found = global.enabled ? library[url] : null;

    entry = found && found.enabled !== false ? found : null;
    cues = entry?.translatedText ? parseSubtitleText(entry.translatedText) : (entry?.sourceText ? parseSubtitleText(entry.sourceText) : []);
    lastCueIndex = -2;
    lastGeometry = '';
    clearNativeFallback();
    if (!currentGlobal.hideOriginalCaptions) restoreOriginalCaptionVisibility();
    if (!entry || !cues.length) hideOverlay();
    if (announce && entry && cues.length) showStatus(`OpenSub: ${cues.length} subtitle cues loaded`);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes[LIBRARY_KEY] || changes[GLOBAL_KEY])) loadBinding({ announce: false });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'opensub-reload') {
      loadBinding({ announce: true }).then(() => sendResponse({ ok: true, url: topPageUrl, cues: cues.length }));
      return true;
    }

    if (message.type === 'opensub-frame-status' || message.type === 'opensub-frame-inspect') {
      const video = bestVideo();
      const rect = video?.getBoundingClientRect();
      sendResponse({
        frameUrl: location.href,
        hasVideo: Boolean(video),
        area: rect ? Math.round(rect.width * rect.height) : 0,
        playing: Boolean(video && !video.paused && !video.ended),
        cueCount: cues.length,
        networkCandidates: networkCandidates.map(item => ({
          id: item.id,
          url: item.url,
          contentType: item.contentType,
          format: item.format,
          via: item.via,
          size: item.size,
          capturedAt: item.capturedAt
        })),
        domCaptionVisible: Boolean(observedDomCaption && Date.now() - observedDomCaptionAt < 1200),
        domCaptionSample: observedDomCaption ? observedDomCaption.slice(0, 180) : '',
        liveActive: Boolean(liveConfig?.enabled),
        liveSourceLanguage: liveConfig?.sourceLanguage || '',
        liveDetectedLanguage: liveConfig?.detectedLanguage || '',
        liveTargetLanguage: liveConfig?.targetLanguage || ''
      });
      return;
    }

    if (message.type === 'opensub-get-network-candidate') {
      const item = networkCandidates.find(candidate => candidate.id === message.id);
      sendResponse(item ? { ok: true, ...item } : { ok: false, error: 'That captured resource is no longer in memory. Play the video with subtitles on and retry.' });
      return;
    }

    if (message.type === 'opensub-start-live') {
      liveConfig = {
        enabled: true,
        sourceLanguage: message.sourceLanguage || 'auto',
        targetLanguage: message.targetLanguage || 'en',
        detectedLanguage: ''
      };
      liveOriginalText = '';
      liveTranslatedText = '';
      livePendingText = '';
      liveLastSeenAt = 0;
      const baselineCandidate = findVisibleCaptionCandidate(bestVideo());
      liveBaselineText = baselineCandidate?.text || '';
      liveBaselineSignature = baselineCandidate?.signature || '';
      liveBaselineStrong = Boolean(baselineCandidate?.strong);
      liveTrustedCaptionSignature = '';
      liveTrustedCaptionElement = null;
      liveSawFreshCaption = !liveBaselineText;
      chrome.runtime.sendMessage({ type: 'opensub-reset-live-language' }).catch(() => {});
      showStatus(`OpenSub live translation: ${liveConfig.sourceLanguage} → ${liveConfig.targetLanguage}`);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'opensub-stop-live') {
      liveConfig = null;
      liveOriginalText = '';
      liveTranslatedText = '';
      livePendingText = '';
      liveLastSeenAt = 0;
      liveBaselineText = '';
      liveBaselineSignature = '';
      liveBaselineStrong = false;
      liveTrustedCaptionSignature = '';
      liveTrustedCaptionElement = null;
      liveSawFreshCaption = false;
      clearLiveNativeFallback();
      if (!entry || !cues.length) restoreOriginalCaptionVisibility();
      showStatus('OpenSub live translation stopped');
      sendResponse({ ok: true });
      return;
    }

  });

  document.addEventListener('fullscreenchange', () => {
    lastGeometry = '';
    const video = bestVideo();
    if (!document.fullscreenElement) moveUiToHost(getDocumentHost());
    else if (video) {
      const fsHost = fullscreenWrapperFor(video);
      if (fsHost && fsHost !== video) moveUiToHost(fsHost);
    }
  }, true);

  setInterval(async () => {
    const now = Date.now();
    if (now - lastContextCheck < 1000) return;
    lastContextCheck = now;
    const context = await getTopContext();
    const next = normalizeUrl(context?.tabUrl || location.href);
    if (next && next !== topPageUrl) loadBinding({ announce: false });
  }, 1200);

  loadBinding({ announce: false });
  if (!rafId) rafId = requestAnimationFrame(render);
})();

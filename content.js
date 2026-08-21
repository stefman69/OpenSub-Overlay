(() => {
  'use strict';

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

  const DEFAULT_GLOBAL = { enabled: true, subtitleSize: 'medium', hideOriginalCaptions: false };
  const SUBTITLE_SIZE_FACTORS = { xsmall: 0.60, small: 0.72, medium: 0.84, large: 0.96, xlarge: 1.10 };
  const LIVE_HOLD_MS = 900;
  const GENERIC_CAPTION_MUTATION_MS = 2600;
  const NETWORK_LIMIT = 12;
  const CAPTION_SELECTOR = [
    '[class*="caption" i]', '[id*="caption" i]', '[class*="subtitle" i]', '[id*="subtitle" i]',
    '[data-testid*="caption" i]', '[data-testid*="subtitle" i]', '[aria-label*="caption" i]',
    '[aria-label*="subtitle" i]', '[aria-live="polite"]', '[aria-live="assertive"]'
  ].join(',');
  const CAPTION_CONTROL_SELECTOR = [
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[role="dialog"]', '[role="menu"]', '[role="menuitem"]',
    '[role="menuitemradio"]', '[role="menuitemcheckbox"]', '[role="listbox"]',
    '[role="option"]', '[role="radio"]', '[role="switch"]', '[role="checkbox"]',
    '[role="slider"]', '[role="tab"]'
  ].join(',');


  let topPageUrl = '';
  let entry = null;
  let cues = [];
  let sourceCues = [];
  let translatedCues = [];
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
  let liveTranslatedSourceText = '';
  let liveOriginalText = '';
  let livePendingText = '';
  let liveLastSeenAt = 0;
  let liveTranslationAttempts = 0;
  let liveTranslationSuccesses = 0;
  let liveLastTranslationError = '';
  let liveBaselineText = '';
  let liveBaselineSignature = '';
  let liveBaselineStrong = false;
  let liveTrustedCaptionSignature = '';
  let liveTrustedCaptionElement = null;
  let liveSawFreshCaption = false;
  let lastDomProbeAt = 0;
  let observedDomCaption = '';
  let observedDomCaptionAt = 0;
  let observedDomCaptionLineCount = 0;
  let observedDomCaptionBounds = null;
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

  // Volatile caption discovery is scoped to the current navigation session. This is intentionally
  // much narrower than the abandoned media-identity experiment: it does not change rendering,
  // saved bindings, fullscreen behavior, or video selection. It only prevents in-memory capture
  // candidates from surviving a single-page-app navigation such as one YouTube video -> another.
  function navigationSessionKey(raw = location.href) {
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
      return normalizeUrl(raw);
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

      const stack = document.createElement('div');
      stack.id = 'opensub-overlay-stack';

      const translated = document.createElement('span');
      translated.id = 'opensub-overlay-text';
      translated.className = 'opensub-overlay-line opensub-translation-line';

      const source = document.createElement('span');
      source.id = 'opensub-overlay-source';
      source.className = 'opensub-overlay-line opensub-source-line';

      stack.append(translated, source);
      root.appendChild(stack);
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

  function findCueIndexIn(list, time) {
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cue = list[mid];
      if (time < cue.start) hi = mid - 1;
      else if (time > cue.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function findCueIndex(time) {
    return findCueIndexIn(cues, time);
  }

  function clearNativeFallback() {
    if (nativeTrack) {
      try { nativeTrack.mode = 'disabled'; } catch (_) {}
    }
    if (nativeTrackVideo?.dataset) delete nativeTrackVideo.dataset.opensubSize;
    nativeTrack = null;
    nativeTrackVideo = null;
  }

  function combinedSavedCueText(time) {
    if (!entry) return '';
    const translatedIndex = findCueIndexIn(translatedCues, time);
    const sourceIndex = findCueIndexIn(sourceCues, time);
    const translated = translatedIndex >= 0 ? translatedCues[translatedIndex].text : '';
    const source = sourceIndex >= 0 ? sourceCues[sourceIndex].text : '';
    const showSource = !entry.translatedText || !currentGlobal.hideOriginalCaptions;
    if (translated && showSource && source) return `${translated}\n${source}`;
    return translated || (showSource ? source : '');
  }

  function installNativeFallback(video) {
    if (!video || !entry || (!translatedCues.length && !sourceCues.length) || typeof VTTCue === 'undefined') return;
    if (nativeTrack && nativeTrackVideo === video) {
      nativeTrack.mode = 'showing';
      return;
    }
    clearNativeFallback();
    try {
      video.dataset.opensubSize = currentGlobal.subtitleSize || 'medium';
      nativeTrack = video.addTextTrack('subtitles', 'OpenSub Overlay', entry.targetLanguage || entry.sourceLanguage || '');
      nativeTrack.mode = 'showing';
      const basis = translatedCues.length ? translatedCues : sourceCues;
      for (const cue of basis) {
        const combined = combinedSavedCueText((cue.start + cue.end) / 2);
        if (!combined) continue;
        const c = new VTTCue(Math.max(0, cue.start - Number(entry.offset || 0)), Math.max(0.01, cue.end - Number(entry.offset || 0)), combined);
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

  function showLiveNativeCue(video, translatedText, sourceText = '') {
    const showSource = !currentGlobal.hideOriginalCaptions;
    const text = translatedText && showSource && sourceText ? `${translatedText}\n${sourceText}` : (translatedText || (showSource ? sourceText : ''));
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

  function isYouTubeDocument() {
    try {
      const host = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
      return host === 'youtube.com' || host === 'm.youtube.com';
    } catch (_) {
      return false;
    }
  }

  function syncYouTubeLiveCaptionSuppression() {
    // YouTube replaces caption spans immediately before paint. Waiting for a MutationObserver
    // to conceal each new span allows a one-frame flash. Keep the renderer-only CSS class armed
    // whenever OpenSub owns caption display: either a Live session or a saved/network subtitle
    // track. The selectors intentionally target only YouTube's timed-caption renderer, never the
    // CC button/menu/settings UI, so users can still disable captions manually if they want to.
    const hasManagedSavedCaptions = Boolean(entry && (sourceCues.length || translatedCues.length));
    const shouldSuppress = Boolean(isYouTubeDocument() && currentGlobal.enabled && (liveConfig?.enabled || hasManagedSavedCaptions));
    try { document.documentElement?.classList.toggle('opensub-youtube-live-suppress', shouldSuppress); } catch (_) {}
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

  function captionVisualContainer(el, video = activeVideo || bestVideo()) {
    if (!(el instanceof Element)) return el;
    const vr = video?.getBoundingClientRect?.();
    if (!vr) return el;

    // YouTube replaces individual ytp-caption-segment spans constantly. Hiding only one span
    // leaves sibling/next-line segments visible, which looks like a third subtitle track.
    // Walk upward to the largest still-caption-sized caption container and conceal that instead.
    let best = el;
    let node = el;
    let depth = 0;
    while (node?.parentElement && depth++ < 5) {
      const parent = node.parentElement;
      if (parent === document.body || parent === document.documentElement) break;
      if (looksLikeCaptionControlUiElement(parent)) break;
      const attrs = captionAttributeChain(parent, 1);
      if (!/(?:caption|subtitle|closed.?caption|captions-text|caption-visual|cue)/i.test(attrs)) break;
      if (looksLikePlayerUiMetadataElement(parent)) break;
      const rect = visibleRect(parent);
      if (!rect || !intersects(rect, vr)) break;
      if (rect.height > vr.height * 0.42 || rect.width > vr.width * 1.12) break;
      best = parent;
      node = parent;
    }
    return best;
  }

  function concealOriginalCaptionElement(el, video = activeVideo || bestVideo()) {
    if (!(el instanceof Element) || looksLikeCaptionControlUiElement(el)) return;
    const target = captionVisualContainer(el, video);
    if (!(target instanceof Element) || looksLikeCaptionControlUiElement(target)) return;
    try {
      target.classList.add('opensub-hide-original-caption');
      hiddenOriginalCaptionElements.add(target);
    } catch (_) {}
  }

  function syncNativeOriginalCaptionVisibility(video, active) {
    if (!video) return;
    // Complete-track playback is rendered as an OpenSub-managed source + translation stack.
    // Hide the site's native caption track while preserving cue availability in hidden mode.
    // Live-only DOM translation is concealed at the trusted DOM element instead, so we avoid
    // changing a site's TextTrack mode before the live detector has learned its source.
    const shouldHide = Boolean(active && entry && (sourceCues.length || translatedCues.length));
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
      if (!el?.isConnected) {
        hiddenOriginalCaptionElements.delete(el);
      } else if (looksLikeCaptionControlUiElement(el)) {
        // Never leave a caption/settings menu transparent just because an earlier detector pass
        // mistook its labels for subtitle dialogue.
        try { el.classList.remove('opensub-hide-original-caption'); } catch (_) {}
        hiddenOriginalCaptionElements.delete(el);
      }
    }
    // Once OpenSub can reproduce the source text itself, suppress the site's visual copy.
    // For Live mode wait until a trusted source node exists; for saved tracks a strongly
    // identified caption node can be concealed immediately.
    const shouldHide = Boolean(active && ((entry && (sourceCues.length || translatedCues.length)) || liveTrustedCaptionElement));
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

  function textsForOverlay(video) {
    if (liveConfig?.enabled && liveOriginalText && Date.now() - liveLastSeenAt < LIVE_HOLD_MS) {
      return {
        // Show the trusted source immediately while translation is still in flight. A translated
        // row is only paired with the exact source text it was produced from.
        translated: liveTranslatedSourceText === liveOriginalText ? liveTranslatedText : '',
        source: currentGlobal.hideOriginalCaptions ? '' : liveOriginalText
      };
    }
    if (!entry || (!translatedCues.length && !sourceCues.length)) return { translated: '', source: '' };
    const effective = Number(video.currentTime || 0) + Number(entry.offset || 0);
    const translatedIndex = findCueIndexIn(translatedCues, effective);
    const sourceIndex = findCueIndexIn(sourceCues, effective);
    lastCueIndex = translatedIndex >= 0 ? translatedIndex : sourceIndex;
    const translated = translatedIndex >= 0 ? translatedCues[translatedIndex].text : '';
    const source = sourceIndex >= 0 ? sourceCues[sourceIndex].text : '';
    return {
      translated,
      source: (!entry.translatedText || !currentGlobal.hideOriginalCaptions) ? source : ''
    };
  }

  function render() {
    rafId = requestAnimationFrame(render);
    syncYouTubeLiveCaptionSuppression();
    const hasSaved = Boolean(entry && cues.length);
    const hasLiveSession = Boolean(liveConfig?.enabled);
    const hasLive = Boolean(hasLiveSession && liveOriginalText && Date.now() - liveLastSeenAt < LIVE_HOLD_MS);
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
        showLiveNativeCue(video, liveTranslatedText, liveOriginalText);
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
    const translatedEl = root.querySelector('#opensub-overlay-text');
    const sourceEl = root.querySelector('#opensub-overlay-source');
    const display = textsForOverlay(video);

    // v1 managed layout: OpenSub owns both visible rows while active. The source caption is
    // redrawn below the translation, so wrapping naturally grows the stack upward and no
    // per-site/native-caption geometry guess is needed.
    root.classList.add('opensub-managed-stack');
    root.classList.toggle('opensub-translation-only', Boolean(currentGlobal.hideOriginalCaptions));

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

    // Managed dual-caption stack: the source line is the bottom block and the translation is
    // directly above it with a constant CSS gap. Any wrapping expands upward automatically.
    translatedEl.textContent = display.translated || '';
    sourceEl.textContent = display.source || '';
    const hasDisplay = Boolean(display.translated || display.source);
    root.style.display = hasDisplay ? 'flex' : 'none';
  }

  function networkSourceKey(detail) {
    const rawUrl = String(detail?.url || '');
    try {
      const u = new URL(rawUrl, location.href);
      const host = u.hostname.replace(/^www\./i, '').toLowerCase();
      if ((host === 'youtube.com' || host === 'm.youtube.com') && /\/api\/timedtext$/i.test(u.pathname)) {
        return [
          'youtube-timedtext',
          u.searchParams.get('v') || '',
          u.searchParams.get('lang') || '',
          u.searchParams.get('tlang') || '',
          u.searchParams.get('kind') || '',
          u.searchParams.get('fmt') || detail?.format || ''
        ].join('|');
      }
    } catch (_) {}
    return `${rawUrl}|${detail?.format || ''}`;
  }

  function candidateId(detail) {
    const raw = `${detail.sessionKey || ''}|${detail.url || ''}|${detail.format || ''}|${String(detail.text || '').slice(0, 220)}`;
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `cap-${(hash >>> 0).toString(16)}`;
  }

  function rememberNetworkCandidate(detail) {
    if (!detail?.text) return;
    const sessionKey = navigationSessionKey(location.href);
    const sourceKey = networkSourceKey(detail);
    const id = candidateId({ ...detail, sessionKey, url: sourceKey });
    const existing = networkCandidates.find(item => item.sessionKey === sessionKey && item.sourceKey === sourceKey);
    const candidate = {
      id,
      sessionKey,
      sourceKey,
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

  function captionAttributeChain(el, maxDepth = 4) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node instanceof Element && depth++ < maxDepth) {
      parts.push([
        node.id || '',
        typeof node.className === 'string' ? node.className : '',
        node.getAttribute?.('aria-label') || '',
        node.getAttribute?.('data-testid') || '',
        node.getAttribute?.('role') || ''
      ].join(' '));
      node = node.parentElement;
    }
    return parts.join(' ').toLowerCase();
  }

  function hasExplicitCaptionSemantics(el) {
    const attrs = captionAttributeChain(el, 4);
    return /(?:closed.?caption|captionbox|ytp-caption|caption-segment|captions-text|caption-visual|subtitle-display|subtitle-container|texttrack|timedtext|timed-text|\bcue\b)/i.test(attrs);
  }

  function looksLikeCaptionControlUiElement(el) {
    if (!(el instanceof Element)) return false;

    // Keep controls/settings separate from timed-caption renderers. Do NOT infer "control UI"
    // merely because a caption renderer lives somewhere under a player whose class names contain
    // words such as "control". That previously caused YouTube's real caption-window,
    // captions-text and ytp-caption-segment nodes to be exempted from suppression.
    const ownAttrs = [
      el.id || '',
      typeof el.className === 'string' ? el.className : '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('data-testid') || '',
      el.getAttribute?.('role') || ''
    ].join(' ').toLowerCase();

    // Explicit timed-caption renderer semantics always win over incidental player/control words.
    // These are visual dialogue surfaces, not settings UI.
    if (/(?:^|[\s_-])(?:caption-window|ytp-caption-window|ytp-caption-segment|captions-text|caption-visual-line|closedcaption|captionbox|subtitle-display|subtitle-container)(?:$|[\s_-])/i.test(ownAttrs)) {
      return false;
    }

    // Interactive structures themselves, or descendants of an actual interactive/menu structure,
    // are UI. This preserves CC buttons, language choices, Off/None options and settings dialogs.
    try {
      if (el.matches(CAPTION_CONTROL_SELECTOR) || el.closest(CAPTION_CONTROL_SELECTOR)) return true;
    } catch (_) {}

    let ownText = '';
    try { ownText = cleanText(el.innerText || el.textContent || '').slice(0, 320); } catch (_) {}
    const ownCombined = `${ownAttrs} ${ownText}`.toLowerCase();

    // Headings such as "Closed Captions and Subtitles" describe a settings panel.
    if (/^H[1-6]$/.test(String(el.tagName || '')) && /(?:caption|subtitle)/i.test(ownCombined)) return true;

    // Restrict semantic menu checks to the element itself plus its immediate parent. Looking six
    // ancestors upward mixed YouTube's caption classes with unrelated player control classes and
    // incorrectly classified the timed captions as menu UI.
    const parent = el.parentElement;
    const parentAttrs = parent instanceof Element ? [
      parent.id || '',
      typeof parent.className === 'string' ? parent.className : '',
      parent.getAttribute?.('aria-label') || '',
      parent.getAttribute?.('data-testid') || '',
      parent.getAttribute?.('role') || ''
    ].join(' ').toLowerCase() : '';
    const nearCombined = `${ownCombined} ${parentAttrs}`;

    if (/(?:captions?-option-list|subtitles?-option-list|captionslist|subtitleslist|caption-settings|subtitle-settings|languagearea)/i.test(nearCombined)) return true;
    if (/(?:advanced settings|customize subtitle|customise subtitle|subtitle appearance|caption appearance)/i.test(nearCombined)) return true;
    if (/(?:caption|subtitle).{0,24}(?:menu|option|setting|preference|language|selector|list|dialog)|(?:menu|option|setting|preference|language|selector|list|dialog).{0,24}(?:caption|subtitle)/i.test(nearCombined)) return true;
    return false;
  }

  function looksLikePlayerUiMetadataElement(el) {
    const attrs = captionAttributeChain(el, 4);
    const looksLikeMetadata = /(?:player.?metadata|video.?metadata|episode.?title|program.?title|content.?title|tile.?subtitle|tile.?title|high-emphasis-tile|standard-emphasis-tile|carousel|scrubber|progress.?bar|time.?display|tooltip)/i.test(attrs);
    return looksLikeMetadata && !hasExplicitCaptionSemantics(el);
  }

  function plausibleCaptionGeometry(info, rect, videoRect) {
    if (!info || !rect || !videoRect) return false;
    if (!info.centered) return false;
    if (info.relativeY < 0.35 || info.relativeY > 1.08) return false;
    if (rect.height > videoRect.height * 0.40) return false;
    if (rect.width > videoRect.width * 1.05) return false;
    return true;
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

  // Measure the actual text boxes occupied by a custom player's rendered captions.
  // Range#getClientRects() gives us the line boxes rather than the potentially huge
  // caption container, which lets OpenSub position itself relative to the real source text.
  function renderedCaptionGeometry(el, text = '', video = null) {
    const hardLines = Math.max(1, String(text || '').split(/\n+/).filter(Boolean).length);
    if (!(el instanceof Element) || !el.isConnected) return { lineCount: hardLines, bounds: null };

    const videoRect = video?.getBoundingClientRect?.() || null;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      let rects = [...range.getClientRects()].filter(r => r.width > 2 && r.height > 4);
      range.detach?.();

      // Ignore line boxes that sit completely outside the playing video. Some streaming
      // players keep hidden accessibility/status text in the same caption container.
      if (videoRect) rects = rects.filter(r => intersects(r, videoRect));

      if (rects.length) {
        const tops = [];
        for (const rect of rects) {
          const centerY = rect.top + rect.height / 2;
          if (!tops.some(y => Math.abs(y - centerY) <= Math.max(3, rect.height * 0.35))) tops.push(centerY);
        }
        const left = Math.min(...rects.map(r => r.left));
        const right = Math.max(...rects.map(r => r.right));
        const top = Math.min(...rects.map(r => r.top));
        const bottom = Math.max(...rects.map(r => r.bottom));
        return {
          lineCount: Math.max(hardLines, Math.min(6, tops.length || 1)),
          bounds: { left, right, top, bottom, width: right - left, height: bottom - top }
        };
      }
    } catch (_) {}

    // Fallback for players whose caption text does not expose individual Range rectangles.
    const rect = visibleRect(el);
    if (rect && (!videoRect || intersects(rect, videoRect))) {
      return {
        lineCount: hardLines,
        bounds: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      };
    }
    return { lineCount: hardLines, bounds: null };
  }

  function renderedCaptionLineCount(el, text = '', video = null) {
    return renderedCaptionGeometry(el, text, video).lineCount;
  }

  function recentSourceCaptionBounds(video) {
    if (currentGlobal.hideOriginalCaptions || !video || !observedDomCaptionBounds) return null;
    if (!observedDomCaption || Date.now() - observedDomCaptionAt > 700) return null;
    const vr = video.getBoundingClientRect();
    const b = observedDomCaptionBounds;
    if (!intersects(b, vr)) return null;

    // Captions normally live in the lower portion of the picture. Reject broad/high UI text
    // even if a player gave it caption-like classes, while still allowing unusually high CC.
    const centerY = (b.top + b.bottom) / 2;
    const relativeY = (centerY - vr.top) / Math.max(1, vr.height);
    if (relativeY < 0.34 || relativeY > 1.08) return null;
    if (b.height > vr.height * 0.32 || b.width > vr.width * 1.08) return null;
    return b;
  }

  function applyMeasuredCaptionClearance(root, video, fsHost) {
    root.classList.remove('opensub-measured-source-position');
    root.style.removeProperty('--opensub-measured-bottom');
    if (currentGlobal.hideOriginalCaptions) return false;

    const bounds = recentSourceCaptionBounds(video);
    if (!bounds) return false;

    const vr = video.getBoundingClientRect();
    const hostRect = fsHost && fsHost !== video ? fsHost.getBoundingClientRect() : vr;
    const hostBottom = hostRect.bottom;
    const hostHeight = Math.max(1, hostRect.height);
    const fontPx = parseFloat(root.style.getPropertyValue('--opensub-font-size')) || Math.max(16, vr.height * 0.04);

    // Put the bottom edge of the translated subtitle just above the top edge of the site's
    // actual rendered caption box. The gap scales gently with OpenSub's own font size.
    const gap = Math.max(6, Math.min(14, fontPx * 0.24));
    let bottom = hostBottom - bounds.top + gap;

    // Safety limits prevent a bad player/accessibility rectangle from throwing the translation
    // into the middle/top of the video. If geometry is implausible, fall back to cue heuristics.
    if (!Number.isFinite(bottom) || bottom < 0 || bottom > hostHeight * 0.52) return false;
    bottom = Math.max(8, bottom);

    root.style.setProperty('--opensub-measured-bottom', `${bottom.toFixed(1)}px`);
    root.classList.add('opensub-measured-source-position');
    return true;
  }

  function nativeHtml5CaptionLineCount(video) {
    if (!video?.textTracks) return 0;
    const vr = video.getBoundingClientRect();
    const approxFontPx = Math.max(16, vr.height * 0.05);
    const maxTextWidth = Math.max(120, vr.width * 0.78);
    const now = Number(video.currentTime || 0);
    let measureContext = null;
    try {
      const canvas = document.createElement('canvas');
      measureContext = canvas.getContext('2d');
      if (measureContext) measureContext.font = `600 ${approxFontPx}px Arial, Helvetica, sans-serif`;
    } catch (_) {}

    let maxLines = 0;
    for (const track of [...video.textTracks]) {
      if (track === nativeTrack || track === liveNativeTrack) continue;

      // Some Shaka/DASH players keep the TextTrack hidden while rendering its cues through
      // their own subtitle layer. Treat caption-like hidden tracks as valid visual evidence,
      // but continue ignoring disabled and unrelated metadata/chapter tracks.
      const descriptor = `${track.kind || ''} ${track.label || ''}`;
      if (!/(?:captions?|subtitles?|shaka|text\s*track|texttrack)/i.test(descriptor)) continue;
      if (track.mode === 'disabled') continue;

      let active = track.activeCues ? [...track.activeCues] : [];
      // A few custom players do not populate activeCues consistently for hidden tracks.
      // Fall back to the cue timing around video.currentTime when the full cue list is exposed.
      if (!active.length && track.cues?.length) {
        try {
          active = [...track.cues].filter(cue => Number(cue.startTime) <= now + 0.08 && Number(cue.endTime) >= now - 0.08);
        } catch (_) {}
      }

      let trackLines = 0;
      for (const cue of active) {
        const raw = String(cue?.text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
        if (!raw.trim()) continue;
        const logicalLines = raw.split(/\n+/).filter(line => line.trim());
        let lineCount = Math.max(1, logicalLines.length);
        if (measureContext) {
          let estimated = 0;
          for (const line of logicalLines.length ? logicalLines : [raw]) {
            const width = measureContext.measureText(line || ' ').width;
            estimated += Math.max(1, Math.ceil(width / maxTextWidth));
          }
          lineCount = Math.max(lineCount, estimated);
        }
        // Multiple simultaneous cues are commonly rendered as stacked rows. Summing here
        // catches players such as Shaka that represent a visual two-line caption as two cues.
        trackLines += lineCount;
      }
      maxLines = Math.max(maxLines, Math.min(6, trackLines));
    }
    return maxLines;
  }

  function sourceCaptionLineCount(video) {
    if (currentGlobal.hideOriginalCaptions) return 0;
    // Use both visual DOM geometry and active TextTrack cues. Some custom players expose only
    // one of these cleanly, and Shaka may render a hidden TextTrack in a separate subtitle DOM.
    const domLines = observedDomCaption && Date.now() - observedDomCaptionAt < 1200
      ? Math.max(1, observedDomCaptionLineCount || 1)
      : 0;
    const trackLines = nativeHtml5CaptionLineCount(video);
    return Math.max(domLines, trackLines);
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
      if (looksLikeCaptionControlUiElement(el)) continue;
      // Reject obvious episode/title/player UI before scoring. Hulu, for example, calls its
      // episode title PlayerMetadata__subTitle, so the word "subtitle" in a CSS class is not
      // sufficient evidence that the node is a caption.
      if (looksLikeMediaMetadata(text) || looksLikePlayerUiMetadataElement(el)) continue;

      const info = captionCandidateScore(el, rect, vr, text, now);
      const signature = captionElementSignature(el);
      if (requiredSignature && signature !== requiredSignature && el !== liveTrustedCaptionElement) continue;

      const plausibleGeometry = plausibleCaptionGeometry(info, rect, vr);
      const explicitCaption = hasExplicitCaptionSemantics(el);

      // Generic accessibility live regions are common in streaming sites and often contain
      // unrelated announcements. They need fresh mutation evidence and caption-like geometry.
      if (!info.strong) {
        if (!info.ariaLive || !info.recentMutation || !plausibleGeometry) continue;
        if (rect.width < vr.width * 0.08 || rect.height < 10) continue;
      }
      if (info.score < (info.strong ? 7 : 10)) continue;

      const activity = noteCaptionSignature(signature, text, now);
      candidates.push({
        el,
        signature,
        text,
        score: info.score,
        strong: info.strong,
        explicitCaption,
        plausibleGeometry,
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
      const geometry = renderedCaptionGeometry(candidate?.el, text, video);
      observedDomCaptionLineCount = geometry.lineCount;
      observedDomCaptionBounds = geometry.bounds;
    } else if (now - observedDomCaptionAt > LIVE_HOLD_MS) {
      observedDomCaption = '';
      observedDomCaptionLineCount = 0;
      observedDomCaptionBounds = null;
    }

    if (!liveConfig?.enabled) return;

    if (!text) {
      if (now - liveLastSeenAt > LIVE_HOLD_MS) {
        // Players such as YouTube briefly destroy/recreate caption nodes between updates. Clear
        // the visible rows after the normal hold time, but do not cancel an in-flight Translator
        // request just because the DOM source disappeared for a moment.
        liveTranslatedText = '';
        liveTranslatedSourceText = '';
        liveOriginalText = '';
        clearLiveNativeFallback();
      }
      return;
    }

    if (!liveTrustedCaptionSignature) {
      const changedFromBaseline = !liveBaselineText || text !== liveBaselineText;
      const sameAsBaselineNode = Boolean(liveBaselineSignature && candidate?.signature === liveBaselineSignature);
      const recentHistory = Number(candidate?.changes || 0) >= 1 && now - Number(candidate?.lastChangeAt || 0) < 15000;

      // Trust behavior, not naming. An explicit caption container can qualify on its first
      // fresh line; a generic caption-like node has to demonstrate an actual text change.
      const provenCaption = Boolean(
        candidate?.plausibleGeometry &&
        !looksLikeMediaMetadata(text) &&
        (
          (candidate?.explicitCaption && candidate?.recentMutation) ||
          (sameAsBaselineNode && candidate?.recentMutation) ||
          recentHistory
        )
      );

      if (!changedFromBaseline || !provenCaption) return;
      liveTrustedCaptionSignature = candidate.signature || '';
      liveTrustedCaptionElement = candidate.el || null;
      liveSawFreshCaption = true;
      if (liveTrustedCaptionElement) concealOriginalCaptionElement(liveTrustedCaptionElement, video);
    }

    // A trusted source is allowed to change its text, but not its DOM identity. If its cue
    // disappears, the overlay is cleared rather than falling through to an unrelated node.
    if (liveTrustedCaptionSignature && candidate?.signature !== liveTrustedCaptionSignature && candidate?.el !== liveTrustedCaptionElement) return;
    if (candidate?.el) concealOriginalCaptionElement(candidate.el, video);

    // Preserve the trusted source immediately. Previously OpenSub waited for translation to
    // finish before storing the source; a brief YouTube DOM gap could clear livePendingText and
    // cause every eventual translation result to be discarded.
    const sourceChanged = text !== liveOriginalText;
    liveOriginalText = text;
    liveLastSeenAt = now;
    if (sourceChanged && liveTranslatedSourceText !== text) {
      liveTranslatedText = '';
      liveTranslatedSourceText = '';
    }

    if (liveTranslatedSourceText === text && liveTranslatedText) return;
    if (text === livePendingText) return;

    livePendingText = text;
    liveTranslationAttempts += 1;
    liveLastTranslationError = '';
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'opensub-live-translate',
        text,
        sourceLanguage: liveConfig.sourceLanguage || 'auto',
        targetLanguage: liveConfig.targetLanguage || 'en'
      });
      if (!liveConfig?.enabled || livePendingText !== text) return;

      // Never revive a stale cue. A result is accepted only if the exact source text that
      // launched it is still the current managed source row and was seen recently.
      if (liveOriginalText !== text || Date.now() - liveLastSeenAt > LIVE_HOLD_MS) return;

      if (result?.ok) {
        liveTranslatedSourceText = text;
        liveTranslatedText = result.text || text;
        liveTranslationSuccesses += 1;
        if (result.sourceLanguage && liveConfig.sourceLanguage === 'auto') liveConfig.detectedLanguage = result.sourceLanguage;
      } else if (result?.error) {
        liveLastTranslationError = String(result.error || '');
        showStatus(`Live translate: ${result.error}`);
      }
    } catch (error) {
      liveLastTranslationError = String(error?.message || error || '');
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
    const data = await safeStorageGet([LIBRARY_KEY, GLOBAL_KEY]);
    const global = { ...DEFAULT_GLOBAL, ...(data[GLOBAL_KEY] || {}) };
    currentGlobal = global;
    const library = data[LIBRARY_KEY] || {};
    const found = global.enabled ? library[url] : null;

    entry = found && found.enabled !== false ? found : null;
    sourceCues = entry?.sourceText ? parseSubtitleText(entry.sourceText) : [];
    translatedCues = entry?.translatedText ? parseSubtitleText(entry.translatedText) : [];
    cues = translatedCues.length ? translatedCues : sourceCues;
    lastCueIndex = -2;
    lastGeometry = '';
    clearNativeFallback();
    if (!entry) restoreOriginalCaptionVisibility();
    if (!entry || !cues.length) hideOverlay();
    if (announce && entry && cues.length) showStatus(`OpenSub: ${cues.length} subtitle cues loaded`);
  }

  function resetLiveDiscovery({ keepRunning = true } = {}) {
    liveOriginalText = '';
    liveTranslatedText = '';
    liveTranslatedSourceText = '';
    livePendingText = '';
    liveLastSeenAt = 0;
    liveTranslationAttempts = 0;
    liveTranslationSuccesses = 0;
    liveLastTranslationError = '';
    liveBaselineText = '';
    liveBaselineSignature = '';
    liveBaselineStrong = false;
    liveTrustedCaptionSignature = '';
    liveTrustedCaptionElement = null;
    liveSawFreshCaption = false;
    observedDomCaption = '';
    observedDomCaptionAt = 0;
    observedDomCaptionLineCount = 0;
    observedDomCaptionBounds = null;
    captionSignatureState.clear();
    clearLiveNativeFallback();
    if (liveConfig) liveConfig.detectedLanguage = '';
    if (!keepRunning) liveConfig = null;
    syncYouTubeLiveCaptionSuppression();
    if (!entry || !cues.length) restoreOriginalCaptionVisibility();
  }

  function resetTransientCaptionSession({ keepLiveRunning = true, replayNetwork = false } = {}) {
    networkCandidates.length = 0;
    resetLiveDiscovery({ keepRunning: keepLiveRunning });
    if (replayNetwork) {
      try {
        window.postMessage({ source: 'opensub-network-probe-control', type: 'opensub-replay-current-captions' }, '*');
      } catch (_) {}
    }
  }

  function debugCaptionCandidates(video) {
    if (!video) return [];
    const vr = video.getBoundingClientRect();
    const now = Date.now();
    let nodes = [];
    try { nodes = [...document.querySelectorAll(CAPTION_SELECTOR)]; } catch (_) { return []; }
    const out = [];
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.id?.startsWith('opensub-') || el.closest?.('#opensub-overlay-root')) continue;
      const rect = visibleRect(el);
      if (!rect || !intersects(rect, vr)) continue;
      const text = cleanText(el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n');
      if (!text || text.length > 1200) continue;
      const info = captionCandidateScore(el, rect, vr, text, now);
      const signature = captionElementSignature(el);
      const activity = signature ? captionSignatureState.get(signature) : null;
      out.push({
        text: text.slice(0, 600),
        signature,
        tag: el.tagName,
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className.slice(0, 500) : '',
        ariaLive: el.getAttribute?.('aria-live') || '',
        ariaLabel: el.getAttribute?.('aria-label') || '',
        dataTestId: el.getAttribute?.('data-testid') || '',
        explicitCaptionSemantics: hasExplicitCaptionSemantics(el),
        rejectedAsPlayerMetadata: looksLikePlayerUiMetadataElement(el),
        rejectedAsCaptionControlUi: looksLikeCaptionControlUiElement(el),
        score: info.score,
        strong: info.strong,
        recentMutation: info.recentMutation,
        mutationAgeMs: Number.isFinite(info.mutationAt) && info.mutationAt ? now - info.mutationAt : null,
        centered: info.centered,
        relativeY: info.relativeY,
        plausibleGeometry: plausibleCaptionGeometry(info, rect, vr),
        looksLikeMediaMetadata: looksLikeMediaMetadata(text),
        observedChanges: Number(activity?.changes || 0),
        lastChangeAgeMs: activity?.lastChangeAt ? now - Number(activity.lastChangeAt) : null,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
      });
    }
    out.sort((a, b) => Number(b.recentMutation) - Number(a.recentMutation) || Number(b.explicitCaptionSemantics) - Number(a.explicitCaptionSemantics) || b.score - a.score);
    return out.slice(0, 40);
  }

  function debugVideoState() {
    return [...document.querySelectorAll('video')].map((video, videoIndex) => {
      const tracks = [...(video.textTracks || [])].map((track, trackIndex) => {
        let activeCues = [];
        let cuePreview = [];
        try { activeCues = [...(track.activeCues || [])].slice(0, 12).map(c => ({ start: c.startTime, end: c.endTime, text: String(c.text || '').slice(0, 500) })); } catch (_) {}
        try { cuePreview = [...(track.cues || [])].slice(0, 12).map(c => ({ start: c.startTime, end: c.endTime, text: String(c.text || '').slice(0, 500) })); } catch (_) {}
        return {
          trackIndex,
          label: track.label || '',
          language: track.language || '',
          kind: track.kind || '',
          mode: track.mode || '',
          cueCount: track.cues ? track.cues.length : null,
          activeCues,
          cuePreview
        };
      });
      return {
        videoIndex,
        currentSrc: String(video.currentSrc || ''),
        src: String(video.src || ''),
        poster: String(video.poster || ''),
        currentTime: Number(video.currentTime || 0),
        duration: Number.isFinite(Number(video.duration)) ? Number(video.duration) : null,
        paused: Boolean(video.paused),
        ended: Boolean(video.ended),
        readyState: Number(video.readyState || 0),
        tracks
      };
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes[LIBRARY_KEY] || changes[GLOBAL_KEY])) loadBinding({ announce: false });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'opensub-debug-dump') {
      const video = bestVideo();
      const overlayRoot = document.getElementById('opensub-overlay-root');
      sendResponse({
        ok: true,
        frameUrl: location.href,
        topPageUrl,
        navigationSessionKey: navigationSessionKey(topPageUrl || location.href),
        currentGlobal: { ...currentGlobal },
        youtubeSuppression: {
          isYouTube: isYouTubeDocument(),
          cssArmed: Boolean(document.documentElement?.classList.contains('opensub-youtube-live-suppress'))
        },
        runtime: {
          hasEntry: Boolean(entry),
          entryTitle: entry?.title || '',
          entryUpdatedAt: entry?.updatedAt || '',
          sourceCueCount: sourceCues.length,
          translatedCueCount: translatedCues.length,
          liveActive: Boolean(liveConfig?.enabled),
          liveConfig: liveConfig ? { ...liveConfig } : null,
          liveOriginalText,
          liveTranslatedText,
          liveTranslatedSourceText,
          livePendingText,
          liveTranslationAttempts,
          liveTranslationSuccesses,
          liveLastTranslationError,
          liveBaselineText,
          liveBaselineSignature,
          liveBaselineStrong,
          liveTrustedCaptionSignature,
          liveTrustedCaptionConnected: Boolean(liveTrustedCaptionElement?.isConnected),
          observedDomCaption,
          observedDomCaptionAgeMs: observedDomCaptionAt ? Date.now() - observedDomCaptionAt : null,
          networkCandidateCount: networkCandidates.length,
          overlayDisplay: overlayRoot ? getComputedStyle(overlayRoot).display : '',
          overlayTranslationText: document.getElementById('opensub-overlay-text')?.textContent || '',
          overlaySourceText: document.getElementById('opensub-overlay-source')?.textContent || ''
        },
        networkCandidates: networkCandidates.map(item => ({
          id: item.id,
          url: item.url,
          contentType: item.contentType,
          format: item.format,
          via: item.via,
          size: item.size,
          capturedAt: item.capturedAt,
          sessionKey: item.sessionKey || '',
          textPreview: String(item.text || '').slice(0, 1200)
        })),
        videos: debugVideoState(),
        captionDomCandidates: debugCaptionCandidates(video)
      });
      return;
    }

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
        networkCandidates: networkCandidates
          .filter(item => item.sessionKey === navigationSessionKey(location.href))
          .map(item => ({
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
      const sessionKey = navigationSessionKey(location.href);
      const item = networkCandidates.find(candidate => candidate.id === message.id && candidate.sessionKey === sessionKey);
      sendResponse(item ? { ok: true, ...item } : { ok: false, error: 'That captured resource is no longer part of the current page session. Play the video with subtitles on and retry.' });
      return;
    }

    if (message.type === 'opensub-reset-caption-session') {
      // Opening the popup starts a fresh discovery pass without deleting saved subtitles.
      // Keep Live enabled if it was running, but force it to qualify the source again.
      resetTransientCaptionSession({ keepLiveRunning: true, replayNetwork: true });
      chrome.runtime.sendMessage({ type: 'opensub-reset-live-language' }).catch(() => {});
      sendResponse({ ok: true });
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
      liveTranslatedSourceText = '';
      livePendingText = '';
      liveLastSeenAt = 0;
      liveTranslationAttempts = 0;
      liveTranslationSuccesses = 0;
      liveLastTranslationError = '';
      const baselineCandidate = findVisibleCaptionCandidate(bestVideo());
      liveBaselineText = baselineCandidate?.text || '';
      liveBaselineSignature = baselineCandidate?.signature || '';
      liveBaselineStrong = Boolean(baselineCandidate?.strong);
      liveTrustedCaptionSignature = '';
      liveTrustedCaptionElement = null;
      liveSawFreshCaption = !liveBaselineText;
      syncYouTubeLiveCaptionSuppression();
      chrome.runtime.sendMessage({ type: 'opensub-reset-live-language' }).catch(() => {});
      showStatus(`OpenSub live translation: ${liveConfig.sourceLanguage} → ${liveConfig.targetLanguage}`);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'opensub-stop-live') {
      liveConfig = null;
      liveOriginalText = '';
      liveTranslatedText = '';
      liveTranslatedSourceText = '';
      livePendingText = '';
      liveLastSeenAt = 0;
      liveTranslationAttempts = 0;
      liveTranslationSuccesses = 0;
      liveLastTranslationError = '';
      liveBaselineText = '';
      liveBaselineSignature = '';
      liveBaselineStrong = false;
      liveTrustedCaptionSignature = '';
      liveTrustedCaptionElement = null;
      liveSawFreshCaption = false;
      syncYouTubeLiveCaptionSuppression();
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
    if (!next || next === topPageUrl) return;

    const oldSession = navigationSessionKey(topPageUrl || location.href);
    const nextSession = navigationSessionKey(next);
    if (nextSession !== oldSession) {
      // SPA navigation/new video: clear only volatile caption discovery state before rebinding.
      // Saved subtitles and global preferences are untouched.
      resetTransientCaptionSession({ keepLiveRunning: false, replayNetwork: false });
      await loadBinding({ announce: false });
    } else {
      // Incidental URL parameters (for example a YouTube time offset) do not define a new
      // caption session and must not stop Live translation.
      topPageUrl = next;
    }
  }, 1200);

  loadBinding({ announce: false });
  if (!rafId) rafId = requestAnimationFrame(render);
})();

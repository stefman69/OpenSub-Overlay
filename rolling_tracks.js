(() => {
  'use strict';

  // Universal rolling TextTrack watcher.
  //
  // Once the user explicitly selects/translates an HTML5 caption/subtitle track, this
  // watcher keeps that source alive when a player appends cues, rolls old cues away,
  // replaces the TextTrack object, or rebuilds the underlying MediaSource timeline.
  // It never renders captions itself; it only keeps OpenSub's normal saved-track entry
  // synchronized, leaving the known-good content.js renderer untouched.
  const LIBRARY_KEY = 'openSubLibrary';
  const BINDINGS_KEY = 'openSubRollingBindings';
  const POLL_MS = 360;
  const WRITE_DEBOUNCE_MS = 120;
  const MAX_TRANSLATIONS_PER_PASS = 8;
  const TIMING_EPSILON = 0.055;
  const SEEK_ABORT_SECONDS = 8;
  const BACKWARD_RESET_SECONDS = 5;
  const SOURCE_ECHO_SELECTOR = '[class*=\"caption\" i], [class*=\"subtitle\" i], [id*=\"caption\" i], [id*=\"subtitle\" i], [aria-live], [role=\"status\"]';
  const STRONG_ECHO_RENDERER_SELECTOR = '[class*=\"caption\" i], [class*=\"subtitle\" i], [id*=\"caption\" i], [id*=\"subtitle\" i]';
  const ECHO_LOCK_STYLE_ID = 'opensub-rolling-echo-renderer-locks';

  let binding = null;
  let topPageUrl = '';
  let running = false;
  let translating = false;
  let writeTimer = 0;
  let lastSignature = '';
  let lastKnownTime = -1;
  let lastVideo = null;
  let lastTrack = null;
  let lastVideoSrc = '';
  let epoch = 0;

  const sourceByKey = new Map();
  const translatedByKey = new Map();
  const pendingKeys = new Set();
  const hiddenSourceEchoElements = new Set();
  const learnedEchoRendererSelectors = new Set();

  const stats = {
    polls: 0,
    reacquisitions: 0,
    trackReplacements: 0,
    sourceReplacements: 0,
    overlapRewrites: 0,
    timelineResets: 0,
    lastBufferCueCount: 0,
    lastActiveCueCount: 0,
    lastWriteAt: '',
    lastChangeReason: '',
    echoMatches: 0,
    echoSuppressedNodes: 0,
    echoLastActiveText: '',
    echoRendererLocks: 0,
    echoRendererSelectors: ''
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
    return holder.value.replace(/\u00a0/g, ' ').replace(/\u200b/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function cueKey(cue) {
    return `${Number(cue.start).toFixed(3)}|${Number(cue.end).toFixed(3)}|${cue.text}`;
  }

  function timingMatches(a, b) {
    return Math.abs(Number(a.start) - Number(b.start)) <= TIMING_EPSILON && Math.abs(Number(a.end) - Number(b.end)) <= TIMING_EPSILON;
  }

  function rangesOverlap(cue, start, end) {
    return Number(cue.end) >= start - TIMING_EPSILON && Number(cue.start) <= end + TIMING_EPSILON;
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

  function fmtTime(seconds) {
    const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
    const ms = totalMs % 1000;
    const totalSeconds = Math.floor(totalMs / 1000);
    const sec = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const min = totalMinutes % 60;
    const hr = Math.floor(totalMinutes / 60);
    return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  function cuesToSrt(cues) {
    return [...cues]
      .sort((a, b) => a.start - b.start || a.end - b.end || a.text.localeCompare(b.text))
      .map((cue, i) => `${i + 1}\n${fmtTime(cue.start)} --> ${fmtTime(cue.end)}\n${cue.text}`)
      .join('\n\n');
  }

  async function getTopContext() {
    try {
      return await chrome.runtime.sendMessage({ type: 'opensub-context' });
    } catch (_) {
      return { tabUrl: location.href };
    }
  }

  function videoCandidates() {
    return [...document.querySelectorAll('video')];
  }

  function isCaptionTrack(track) {
    if (!track) return false;
    const descriptor = `${track.kind || ''} ${track.label || ''}`;
    return /captions?|subtitles?|text\s*track|texttrack|shaka/i.test(descriptor) && !/^OpenSub\b/i.test(String(track.label || ''));
  }

  function trackMatches(track) {
    if (!isCaptionTrack(track)) return false;
    if (binding?.label && String(track.label || '') !== String(binding.label)) return false;
    if (binding?.language && String(track.language || '') !== String(binding.language)) return false;
    if (binding?.kind && String(track.kind || '') !== String(binding.kind)) return false;
    return true;
  }

  function trackScore(track) {
    let score = 0;
    try { score += Number(track.activeCues?.length || 0) * 1000; } catch (_) {}
    try { score += Number(track.cues?.length || 0); } catch (_) {}
    try { if (track.mode !== 'disabled') score += 100; } catch (_) {}
    return score;
  }

  function bestMatchingTrack(video) {
    if (!video?.textTracks) return null;
    const tracks = [...video.textTracks];
    const direct = tracks[Number(binding?.trackIndex)] || null;
    if (direct && trackMatches(direct)) {
      // Prefer the originally selected index unless another matching replacement is clearly
      // the live one (active cues / substantially more populated rolling buffer).
      const alternatives = tracks.filter(trackMatches).sort((a, b) => trackScore(b) - trackScore(a));
      const best = alternatives[0] || direct;
      if (trackScore(best) > trackScore(direct) + 500) return best;
      return direct;
    }
    return tracks.filter(trackMatches).sort((a, b) => trackScore(b) - trackScore(a))[0] || null;
  }

  function resolveVideoAndTrack() {
    if (!binding) return null;
    const videos = videoCandidates();
    const directVideo = videos[Number(binding.videoIndex)] || null;
    if (directVideo) {
      const track = bestMatchingTrack(directVideo);
      if (track) return { video: directVideo, track };
    }
    for (const video of videos) {
      const track = bestMatchingTrack(video);
      if (track) return { video, track };
    }
    return null;
  }

  function copyTrackCues(track, now = 0) {
    try { if (track.mode === 'disabled') track.mode = 'hidden'; } catch (_) {}
    let list = [];
    try { list = [...(track.cues || [])]; } catch (_) {}
    // A few rolling players momentarily expose only activeCues while swapping buffers.
    if (!list.length) {
      try { list = [...(track.activeCues || [])]; } catch (_) {}
    }
    const out = [];
    for (const cue of list) {
      const text = cleanText(cue?.text || '');
      const start = Number(cue?.startTime);
      const end = Number(cue?.endTime);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      out.push({ start, end, text });
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end || a.text.localeCompare(b.text));
    return out;
  }

  function activeCueCount(track) {
    try { return [...(track?.activeCues || [])].filter(c => cleanText(c?.text || '')).length; } catch (_) { return 0; }
  }

  function normalizedEchoText(text) {
    return cleanText(text).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function visibleElementRect(el) {
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

  function rectsIntersect(a, b) {
    return Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
  }

  function isOpenSubRelatedElement(el) {
    if (!(el instanceof Element)) return true;
    const overlay = document.getElementById('opensub-overlay-root');
    if (el.id?.startsWith('opensub-') || el.closest?.('#opensub-overlay-root')) return true;
    if (overlay && (el === overlay || el.contains(overlay))) return true;
    return false;
  }

  function cssEscapeToken(value) {
    try { return CSS.escape(String(value || '')); } catch (_) {
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
    }
  }

  function clearEchoRendererLocks() {
    try { document.getElementById(ECHO_LOCK_STYLE_ID)?.remove(); } catch (_) {}
    learnedEchoRendererSelectors.clear();
    stats.echoRendererLocks = 0;
    stats.echoRendererSelectors = '';
  }

  function updateEchoRendererLockStyle() {
    let style = document.getElementById(ECHO_LOCK_STYLE_ID);
    if (!learnedEchoRendererSelectors.size) {
      try { style?.remove(); } catch (_) {}
      stats.echoRendererLocks = 0;
      stats.echoRendererSelectors = '';
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = ECHO_LOCK_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = [...learnedEchoRendererSelectors].map(selector =>
      `${selector} { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }`
    ).join('\n');
    stats.echoRendererLocks = learnedEchoRendererSelectors.size;
    stats.echoRendererSelectors = [...learnedEchoRendererSelectors].join(' | ').slice(0, 600);
  }

  function rendererSelectorForConfirmedEcho(el) {
    if (!(el instanceof Element)) return '';
    let node = el;
    while (node && node !== document.documentElement) {
      if (isOpenSubRelatedElement(node)) return '';
      let stronglyCaptionLike = false;
      try { stronglyCaptionLike = node.matches(STRONG_ECHO_RENDERER_SELECTOR); } catch (_) {}
      if (stronglyCaptionLike) {
        const id = String(node.id || '');
        if (id && /(caption|subtitle)/i.test(id)) {
          const selector = `${node.tagName.toLowerCase()}#${cssEscapeToken(id)}`;
          try {
            const count = document.querySelectorAll(selector).length;
            if (count > 0 && count <= 12) return selector;
          } catch (_) {}
        }
        const classes = [...(node.classList || [])]
          .filter(name => /(caption|subtitle)/i.test(name) && !/^opensub-/i.test(name))
          .sort((a, b) => {
            const aHashy = /(?:^|[-_])[a-z0-9]{5,}$/i.test(a) ? 1 : 0;
            const bHashy = /(?:^|[-_])[a-z0-9]{5,}$/i.test(b) ? 1 : 0;
            return aHashy - bHashy || a.length - b.length;
          });
        for (const className of classes) {
          const selector = `${node.tagName.toLowerCase()}.${cssEscapeToken(className)}`;
          try {
            const count = document.querySelectorAll(selector).length;
            if (count > 0 && count <= 12) return selector;
          } catch (_) {}
        }
      }
      node = node.parentElement;
    }
    return '';
  }

  function lockConfirmedEchoRenderer(el) {
    const selector = rendererSelectorForConfirmedEcho(el);
    if (!selector || learnedEchoRendererSelectors.has(selector)) return false;
    learnedEchoRendererSelectors.add(selector);
    updateEchoRendererLockStyle();
    return true;
  }

  function restoreSourceEchoVisibility() {
    for (const el of [...hiddenSourceEchoElements]) {
      try { el.classList.remove('opensub-rolling-hide-source-echo'); } catch (_) {}
      hiddenSourceEchoElements.delete(el);
    }
    clearEchoRendererLocks();
    stats.echoSuppressedNodes = 0;
  }

  function echoTextMatches(text, activeTexts) {
    const normalized = normalizedEchoText(text);
    if (!normalized || !activeTexts.length) return false;
    const normalizedActive = activeTexts.map(normalizedEchoText).filter(Boolean);
    if (!normalizedActive.length) return false;
    if (normalizedActive.includes(normalized)) return true;
    const joined = normalizedEchoText(normalizedActive.join(' '));
    if (normalized === joined) return true;
    const reversed = normalizedEchoText([...normalizedActive].reverse().join(' '));
    if (normalized === reversed) return true;
    // Some players put each simultaneous cue on its own DOM line but reorder the two rows.
    // Compare the line/text multiset as a final exact-content check rather than substring matching.
    const parts = String(text || '').split(/\n+/).map(normalizedEchoText).filter(Boolean).sort();
    const activeParts = normalizedActive.flatMap(t => t.split(/\n+/).map(normalizedEchoText).filter(Boolean)).sort();
    return parts.length === activeParts.length && parts.every((part, i) => part === activeParts[i]);
  }

  function sourceEchoRoots(video) {
    const roots = [];
    try {
      for (const el of document.querySelectorAll(SOURCE_ECHO_SELECTOR)) {
        if (!(el instanceof Element) || isOpenSubRelatedElement(el)) continue;
        const rect = visibleElementRect(el);
        const vr = video?.getBoundingClientRect?.();
        if (!rect || !vr || !rectsIntersect(rect, vr)) continue;
        roots.push(el);
      }
    } catch (_) {}
    return roots;
  }

  function syncSourceEchoSuppression(video, track) {
    if (!running || !video || !track) {
      restoreSourceEchoVisibility();
      return;
    }
    let active = [];
    try {
      active = [...(track.activeCues || [])]
        .map(cue => cleanText(cue?.text || ''))
        .filter(Boolean);
    } catch (_) {}
    stats.echoLastActiveText = active.join(' | ').slice(0, 300);

    // Keep already hidden reusable caption nodes concealed while the rolling binding is active,
    // but restore disconnected nodes so a player can freely rebuild its caption renderer.
    for (const el of [...hiddenSourceEchoElements]) {
      if (!el?.isConnected) hiddenSourceEchoElements.delete(el);
      else if (isOpenSubRelatedElement(el)) {
        try { el.classList.remove('opensub-rolling-hide-source-echo'); } catch (_) {}
        hiddenSourceEchoElements.delete(el);
      }
    }
    if (!active.length) {
      stats.echoSuppressedNodes = hiddenSourceEchoElements.size;
      return;
    }

    const videoRect = video.getBoundingClientRect();
    const candidates = new Set();
    for (const root of sourceEchoRoots(video)) {
      candidates.add(root);
      // Caption roots often use random class names on the actual text rows (Tubi does this),
      // so inspect their descendants even when only the ancestor has caption semantics.
      try {
        for (const child of root.querySelectorAll('div, span, p')) candidates.add(child);
      } catch (_) {}
    }

    const matches = [];
    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || isOpenSubRelatedElement(el)) continue;
      const rect = visibleElementRect(el);
      if (!rect || !rectsIntersect(rect, videoRect)) continue;
      // Never conceal player-sized wrappers. We only want the smallest node that actually
      // renders the duplicate caption text.
      if (rect.width > videoRect.width * 1.06 || rect.height > videoRect.height * 0.45) continue;
      const text = cleanText(el.innerText || el.textContent || '');
      if (!echoTextMatches(text, active)) continue;
      matches.push({ el, area: rect.width * rect.height, text });
    }

    if (matches.length) {
      // Suppress only minimal matching nodes; if a child and ancestor both match, the child wins.
      matches.sort((a, b) => a.area - b.area);
      const chosen = [];
      for (const match of matches) {
        if (chosen.some(item => match.el.contains(item.el))) continue;
        chosen.push(match);
      }
      for (const { el } of chosen.slice(0, 8)) {
        if (isOpenSubRelatedElement(el)) continue;
        // The exact-text match proves which DOM branch is echoing the active TextTrack.
        // Promote that discovery into a renderer-level CSS lock so regenerated caption
        // nodes are hidden at insertion time instead of flashing until the next poll.
        lockConfirmedEchoRenderer(el);
        try {
          el.classList.add('opensub-rolling-hide-source-echo');
          hiddenSourceEchoElements.add(el);
        } catch (_) {}
      }
      stats.echoMatches += chosen.length;
    }
    stats.echoSuppressedNodes = hiddenSourceEchoElements.size;
  }

  function translatedCueForSource(sourceCue) {
    const exact = translatedByKey.get(cueKey(sourceCue));
    if (exact) return exact;
    // Entries created by the popup are matched by timing when we first prime the watcher.
    for (const [key, cue] of translatedByKey) {
      if (!key.endsWith('|*')) continue;
      if (timingMatches(cue, sourceCue)) return cue;
    }
    return null;
  }

  async function primeFromSavedEntry() {
    if (!topPageUrl) return;
    const data = await chrome.storage.local.get(LIBRARY_KEY);
    const entry = (data[LIBRARY_KEY] || {})[topPageUrl];
    const savedSource = parseSrt(entry?.sourceText || '');
    for (const cue of savedSource) sourceByKey.set(cueKey(cue), cue);
    for (const cue of parseSrt(entry?.translatedText || '')) {
      const source = savedSource.find(src => timingMatches(src, cue));
      translatedByKey.set(source ? cueKey(source) : `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|*`, cue);
    }
  }

  function deleteTranslatedForSourceKeys(keys) {
    for (const key of keys) translatedByKey.delete(key);
    // Remove timing placeholders that overlap deleted source cues too.
    for (const [key, cue] of [...translatedByKey]) {
      if (!key.endsWith('|*')) continue;
      if ([...keys].some(sourceKey => {
        const src = sourceByKey.get(sourceKey);
        return src && timingMatches(src, cue);
      })) translatedByKey.delete(key);
    }
  }

  function clearAllDynamicCues(reason) {
    sourceByKey.clear();
    translatedByKey.clear();
    pendingKeys.clear();
    epoch++;
    stats.timelineResets++;
    stats.lastChangeReason = reason;
  }

  function removeWindow(start, end) {
    const removed = [];
    for (const [key, cue] of [...sourceByKey]) {
      if (rangesOverlap(cue, start, end)) {
        removed.push({ key, cue });
        sourceByKey.delete(key);
      }
    }
    for (const { key, cue } of removed) {
      translatedByKey.delete(key);
      for (const [tKey, translated] of [...translatedByKey]) {
        if (tKey.endsWith('|*') && timingMatches(cue, translated)) translatedByKey.delete(tKey);
      }
    }
    return removed.length;
  }

  function countTimingRewrites(buffer) {
    if (!buffer.length || !sourceByKey.size) return 0;
    const existing = [...sourceByKey.values()];
    let rewrites = 0;
    for (const cue of buffer) {
      const sameTiming = existing.filter(old => timingMatches(old, cue));
      if (sameTiming.length && !sameTiming.some(old => old.text === cue.text)) rewrites++;
    }
    return rewrites;
  }

  function mergeCurrentBuffer(buffer, { replaceWindow = false } = {}) {
    if (!buffer.length) return 0;
    if (replaceWindow) {
      const start = Math.min(...buffer.map(c => c.start)) - 0.12;
      const end = Math.max(...buffer.map(c => c.end)) + 0.12;
      removeWindow(start, end);
    }
    let added = 0;
    for (const cue of buffer) {
      const key = cueKey(cue);
      if (!sourceByKey.has(key)) added++;
      sourceByKey.set(key, cue);
    }
    return added;
  }

  function scheduleWrite(delay = WRITE_DEBOUNCE_MS) {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => writeMergedLibrary().catch(() => {}), delay);
  }

  async function writeMergedLibrary() {
    if (!running || !topPageUrl || !binding) return;
    const data = await chrome.storage.local.get(LIBRARY_KEY);
    const library = data[LIBRARY_KEY] || {};
    const existing = library[topPageUrl] || {};
    const sourceCues = [...sourceByKey.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.text.localeCompare(b.text));
    const translatedCues = sourceCues.map(src => translatedCueForSource(src)).filter(Boolean).sort((a, b) => a.start - b.start || a.end - b.end);
    if (!sourceCues.length) return;

    library[topPageUrl] = {
      ...existing,
      pageUrl: topPageUrl,
      title: existing.title || document.title || 'Video page',
      enabled: existing.enabled !== false,
      sourceLanguage: binding.sourceLanguage || existing.sourceLanguage || 'auto',
      targetLanguage: binding.targetLanguage || existing.targetLanguage || '',
      sourceFileName: existing.sourceFileName || `${binding.label || 'rolling-subtitles'}.srt`,
      sourceText: cuesToSrt(sourceCues),
      translatedText: translatedCues.length ? cuesToSrt(translatedCues) : '',
      cueCount: sourceCues.length,
      updatedAt: new Date().toISOString(),
      dynamicSource: 'rolling-texttrack'
    };
    await chrome.storage.local.set({ [LIBRARY_KEY]: library });
    stats.lastWriteAt = new Date().toISOString();
  }

  async function translateCue(sourceCue, passEpoch) {
    if (!binding?.targetLanguage) return;
    const key = cueKey(sourceCue);
    if (translatedCueForSource(sourceCue) || pendingKeys.has(key)) return;
    pendingKeys.add(key);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'opensub-live-translate',
        text: sourceCue.text,
        sourceLanguage: binding.sourceLanguage || 'auto',
        targetLanguage: binding.targetLanguage || 'en'
      });
      if (!running || !binding || passEpoch !== epoch) return;
      if (result?.ok) {
        translatedByKey.set(key, {
          start: sourceCue.start,
          end: sourceCue.end,
          text: String(result.text || sourceCue.text).trim() || sourceCue.text
        });
        if (result.sourceLanguage && binding.sourceLanguage === 'auto') binding.detectedLanguage = result.sourceLanguage;
        // Make the active translation visible quickly rather than waiting for a large batch.
        scheduleWrite(35);
      }
    } catch (_) {
      // Transient translator/model errors do not stop the watcher; a cue can retry while it
      // remains in a later rolling buffer.
    } finally {
      pendingKeys.delete(key);
    }
  }

  async function processCurrentBuffer() {
    if (!running || translating || !binding) return;
    stats.polls++;
    const resolved = resolveVideoAndTrack();
    if (!resolved) return;
    const { video, track } = resolved;
    const now = Number(video.currentTime || 0);
    const src = String(video.currentSrc || video.src || '');
    const buffer = copyTrackCues(track, now);
    const activeCount = activeCueCount(track);
    stats.lastBufferCueCount = buffer.length;
    stats.lastActiveCueCount = activeCount;
    syncSourceEchoSuppression(video, track);
    if (!buffer.length) return;

    const firstResolution = !lastVideo || !lastTrack;
    const videoChanged = Boolean(lastVideo && video !== lastVideo);
    const trackChanged = Boolean(lastTrack && track !== lastTrack);
    const srcChanged = Boolean(lastVideoSrc && src && src !== lastVideoSrc);
    const timeJumpBack = lastKnownTime >= 0 && now + BACKWARD_RESET_SECONDS < lastKnownTime;
    const rewrites = countTimingRewrites(buffer);
    const rewriteRatio = buffer.length ? rewrites / buffer.length : 0;
    const meaningfulRewrite = rewrites >= 2 || rewriteRatio >= 0.25;

    if (!firstResolution && (videoChanged || trackChanged)) stats.reacquisitions++;
    if (trackChanged) stats.trackReplacements++;
    if (srcChanged) stats.sourceReplacements++;
    if (meaningfulRewrite) stats.overlapRewrites++;

    // A source/track swap plus a backwards clock jump is a new rolling epoch (Tubi Live does
    // this when it regenerates its MediaSource). Old cues with reused timestamps must not
    // remain eligible for playback.
    if (!firstResolution && timeJumpBack && (videoChanged || trackChanged || srcChanged || meaningfulRewrite)) {
      clearAllDynamicCues('timeline-reset');
    }

    // If the timeline itself continues but a player replaces/re-writes its current cue window,
    // discard only that overlapping window. This preserves useful VOD history while ensuring
    // newly reused timestamps cannot compete with stale text.
    const replaceWindow = !timeJumpBack && (meaningfulRewrite || trackChanged || srcChanged);
    if (replaceWindow) stats.lastChangeReason = meaningfulRewrite ? 'overlap-rewrite' : (trackChanged ? 'track-replaced' : 'source-replaced');

    const added = mergeCurrentBuffer(buffer, { replaceWindow });
    if (added || replaceWindow || timeJumpBack) {
      // Source cues are written immediately, before translation, so the managed original row
      // does not disappear while Chrome translates the next live line.
      await writeMergedLibrary();
    }

    const signature = `${buffer.length}|${buffer[0]?.start?.toFixed(2)}|${buffer.at(-1)?.end?.toFixed(2)}|${now.toFixed(1)}|${activeCount}`;
    const noMeaningfulChange = signature === lastSignature && Math.abs(now - lastKnownTime) < 1.0;

    lastSignature = signature;
    lastKnownTime = now;
    lastVideo = video;
    lastTrack = track;
    lastVideoSrc = src;

    if (noMeaningfulChange && !added) return;
    if (!binding.targetLanguage) return;

    const passEpoch = epoch;
    const untranslated = buffer
      .filter(cue => !translatedCueForSource(cue) && !pendingKeys.has(cueKey(cue)))
      .sort((a, b) => {
        const aActive = a.start <= now + 0.30 && a.end >= now - 0.30 ? 0 : 1;
        const bActive = b.start <= now + 0.30 && b.end >= now - 0.30 ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        const aFuture = a.start >= now ? 0 : 1;
        const bFuture = b.start >= now ? 0 : 1;
        if (aFuture !== bFuture) return aFuture - bFuture;
        return Math.abs(a.start - now) - Math.abs(b.start - now);
      })
      .slice(0, MAX_TRANSLATIONS_PER_PASS);

    if (!untranslated.length) return;
    translating = true;
    try {
      for (const cue of untranslated) {
        if (!running || passEpoch !== epoch) break;
        await translateCue(cue, passEpoch);
        const latest = resolveVideoAndTrack();
        if (latest?.video && Math.abs(Number(latest.video.currentTime || 0) - now) > SEEK_ABORT_SECONDS) break;
      }
    } finally {
      translating = false;
    }
  }

  async function persistBinding() {
    if (!binding || !topPageUrl) return;
    const data = await chrome.storage.local.get(BINDINGS_KEY);
    const all = data[BINDINGS_KEY] || {};
    all[topPageUrl] = {
      ...binding,
      pageUrl: topPageUrl,
      frameUrl: normalizeUrl(location.href),
      updatedAt: new Date().toISOString()
    };
    await chrome.storage.local.set({ [BINDINGS_KEY]: all });
  }

  async function start(newBinding, { persist = true } = {}) {
    const context = await getTopContext();
    topPageUrl = normalizeUrl(newBinding?.pageUrl || context?.tabUrl || location.href);
    binding = {
      videoIndex: Number(newBinding?.videoIndex || 0),
      trackIndex: Number(newBinding?.trackIndex || 0),
      label: String(newBinding?.label || ''),
      language: String(newBinding?.language || ''),
      kind: String(newBinding?.kind || ''),
      sourceLanguage: String(newBinding?.sourceLanguage || 'auto'),
      targetLanguage: String(newBinding?.targetLanguage || ''),
      sourceFileName: String(newBinding?.sourceFileName || '')
    };
    restoreSourceEchoVisibility();
    running = true;
    translating = false;
    clearTimeout(writeTimer);
    lastSignature = '';
    lastKnownTime = -1;
    lastVideo = null;
    lastTrack = null;
    lastVideoSrc = '';
    epoch++;
    sourceByKey.clear();
    translatedByKey.clear();
    pendingKeys.clear();
    stats.lastChangeReason = 'started';
    await primeFromSavedEntry();
    try { await chrome.runtime.sendMessage({ type: 'opensub-reset-live-language' }); } catch (_) {}
    if (persist) await persistBinding();
    processCurrentBuffer().catch(() => {});
    return { ok: true, rolling: true };
  }

  async function stop({ forget = false } = {}) {
    restoreSourceEchoVisibility();
    running = false;
    translating = false;
    binding = null;
    pendingKeys.clear();
    clearTimeout(writeTimer);
    lastVideo = null;
    lastTrack = null;
    lastVideoSrc = '';
    if (forget && topPageUrl) {
      const data = await chrome.storage.local.get(BINDINGS_KEY);
      const all = data[BINDINGS_KEY] || {};
      delete all[topPageUrl];
      await chrome.storage.local.set({ [BINDINGS_KEY]: all });
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'opensub-rolling-start-track') {
      start(message.binding || {}, { persist: true }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === 'opensub-rolling-stop-track') {
      stop({ forget: Boolean(message.forget) }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === 'opensub-rolling-status') {
      const resolved = resolveVideoAndTrack();
      sendResponse({
        ok: true,
        running,
        binding,
        topPageUrl,
        frameUrl: normalizeUrl(location.href),
        epoch,
        bufferedSourceCues: sourceByKey.size,
        translatedCues: translatedByKey.size,
        resolved: Boolean(resolved),
        currentTime: Number(resolved?.video?.currentTime || 0),
        currentSrc: String(resolved?.video?.currentSrc || resolved?.video?.src || ''),
        track: resolved?.track ? {
          label: resolved.track.label || '',
          language: resolved.track.language || '',
          kind: resolved.track.kind || '',
          mode: resolved.track.mode || '',
          cueCount: resolved.track.cues?.length ?? null,
          activeCueCount: resolved.track.activeCues?.length ?? null
        } : null,
        stats: { ...stats }
      });
      return;
    }
  });

  setInterval(() => {
    if (running) processCurrentBuffer().catch(() => {});
  }, POLL_MS);

  // Streaming SPAs can reuse the same document for a completely different video/page. A
  // rolling watcher belongs to the page on which it was explicitly started; never let that
  // binding or its learned caption-renderer locks bleed into a later route.
  let navigationCheckBusy = false;
  setInterval(async () => {
    if (!running || navigationCheckBusy) return;
    navigationCheckBusy = true;
    try {
      const context = await getTopContext();
      const currentPage = normalizeUrl(context?.tabUrl || location.href);
      if (topPageUrl && currentPage && currentPage !== topPageUrl) {
        stats.lastChangeReason = 'page-navigation-stop';
        await stop({ forget: false });
        topPageUrl = currentPage;
      }
    } catch (_) {
    } finally {
      navigationCheckBusy = false;
    }
  }, 850);

  // Re-arm a previously selected rolling track after a normal reload when this exact frame
  // still exists. We deliberately do not search arbitrary frames or start DOM Live mode.
  (async () => {
    const context = await getTopContext();
    topPageUrl = normalizeUrl(context?.tabUrl || location.href);
    const data = await chrome.storage.local.get(BINDINGS_KEY);
    const saved = (data[BINDINGS_KEY] || {})[topPageUrl];
    if (!saved) return;
    const savedFrame = normalizeUrl(saved.frameUrl || '');
    const thisFrame = normalizeUrl(location.href);
    if (savedFrame && savedFrame !== thisFrame) return;
    setTimeout(() => start(saved, { persist: false }).catch(() => {}), 1200);
  })();
})();

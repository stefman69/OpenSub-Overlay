(() => {
  'use strict';

  // Pluto/Shaka adapter only. This file intentionally does not render subtitles itself.
  // It incrementally mirrors/ translates the selected Shaka TextTrack into OpenSub's
  // normal saved-track library so the known-good global renderer remains untouched.
  const LIBRARY_KEY = 'openSubLibrary';
  const BINDINGS_KEY = 'openSubPlutoBindings';
  const POLL_MS = 450;
  const MAX_TRANSLATIONS_PER_PASS = 10;
  const WRITE_DEBOUNCE_MS = 500;

  let binding = null;
  let topPageUrl = '';
  let running = false;
  let translating = false;
  let writeTimer = 0;
  let lastTrackSignature = '';
  let lastKnownTime = -1;

  const sourceByKey = new Map();
  const translatedByKey = new Map();
  const pendingKeys = new Set();

  // Pluto-only original-caption suppression. Keep this adapter isolated so Hulu/YouTube
  // continue using the exact v1.0.11 renderer that is already working well.
  //
  // Important safety rule: NEVER hide a Shaka container/ancestor that contains OpenSub.
  // Pluto can mount extension UI inside a player/text wrapper; hiding that ancestor would
  // erase the translation too. We only conceal actual caption children or exact cue-matching
  // visual nodes that neither contain nor live inside OpenSub's own overlay.
  const PLUTO_NODE_SUPPRESS_CLASS = 'opensub-pluto-original-caption';
  const suppressedVisualNodes = new Map();
  let suppressionObserver = null;
  let suppressionScheduled = false;
  let suppressionStats = { hiddenTracks: 0, shakaCaptionChildren: 0, cueMatchedNodes: 0 };

  function comparableText(value) {
    return cleanText(value).replace(/\s+/g, ' ').trim();
  }

  function isOpenSubTrack(track) {
    return /^OpenSub\b/i.test(String(track?.label || ''));
  }

  function touchesOpenSubUi(el) {
    if (!(el instanceof Element)) return false;
    try {
      if (el.id?.startsWith('opensub-')) return true;
      if (el.closest?.('#opensub-overlay-root, #opensub-overlay-status')) return true;
      if (el.querySelector?.('#opensub-overlay-root, #opensub-overlay-status')) return true;
    } catch (_) {}
    return false;
  }

  function forcePlutoCaptionTracksHidden(video) {
    let hidden = 0;
    for (const track of [...(video?.textTracks || [])]) {
      if (isOpenSubTrack(track)) continue;
      if (!/captions|subtitles/i.test(String(track?.kind || ''))) continue;
      try {
        if (track.mode !== 'hidden') track.mode = 'hidden';
        if (track.mode === 'hidden') hidden++;
      } catch (_) {}
    }
    return hidden;
  }

  function activeCueTexts(track) {
    const out = new Set();
    try {
      for (const cue of [...(track?.activeCues || [])]) {
        const text = comparableText(cue?.text || '');
        if (text) out.add(text);
      }
    } catch (_) {}
    return out;
  }

  function visibleRect(el) {
    if (!(el instanceof Element)) return null;
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) < 0.02) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      return r;
    } catch (_) { return null; }
  }

  function intersects(a, b) {
    return Boolean(a && b && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom);
  }

  function concealPlutoNode(el) {
    if (!(el instanceof HTMLElement) || touchesOpenSubUi(el)) return false;
    try {
      if (!suppressedVisualNodes.has(el)) {
        suppressedVisualNodes.set(el, {
          visibility: el.style.getPropertyValue('visibility'),
          visibilityPriority: el.style.getPropertyPriority('visibility'),
          opacity: el.style.getPropertyValue('opacity'),
          opacityPriority: el.style.getPropertyPriority('opacity')
        });
      }
      el.classList.add(PLUTO_NODE_SUPPRESS_CLASS);
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
      return true;
    } catch (_) { return false; }
  }

  function walkOpenRoots(root = document, out = []) {
    out.push(root);
    let elements = [];
    try { elements = [...root.querySelectorAll('*')]; } catch (_) { return out; }
    for (const el of elements) {
      try { if (el.shadowRoot) walkOpenRoots(el.shadowRoot, out); } catch (_) {}
    }
    return out;
  }

  // Never suppress .shaka-text-container itself. Only suppress its caption children that
  // do not contain OpenSub. This avoids the exact regression where the translation vanished.
  function suppressStandardShakaCaptionChildren() {
    let count = 0;
    for (const root of walkOpenRoots()) {
      let containers = [];
      try { containers = [...root.querySelectorAll('.shaka-text-container')]; } catch (_) {}
      for (const container of containers) {
        let children = [];
        try { children = [...container.children]; } catch (_) {}
        for (const child of children) {
          if (touchesOpenSubUi(child)) continue;
          if (concealPlutoNode(child)) count++;
        }
      }
    }
    return count;
  }

  function plutoPlayerSearchRoot(video) {
    if (!(video instanceof Element)) return document;
    try {
      return video.closest('[data-shaka-player-container], .shaka-video-container, [class*="player" i], [class*="video" i]') || video.parentElement?.parentElement || document;
    } catch (_) {
      return video.parentElement?.parentElement || document;
    }
  }

  function suppressCueMatchedVisuals(video, track) {
    const texts = activeCueTexts(track);
    if (!texts.size || !video) return 0;
    const vr = video.getBoundingClientRect();
    if (!vr.width || !vr.height) return 0;
    let count = 0;

    for (const root of walkOpenRoots(plutoPlayerSearchRoot(video))) {
      let nodes = [];
      try { nodes = [...root.querySelectorAll('span,div,p')]; } catch (_) {}
      for (const el of nodes) {
        if (!(el instanceof HTMLElement) || touchesOpenSubUi(el)) continue;
        const rect = visibleRect(el);
        if (!rect || !intersects(rect, vr)) continue;
        if (rect.top < vr.top + vr.height * 0.30) continue;
        if (rect.height > vr.height * 0.38 || rect.width > vr.width * 1.15) continue;
        const text = comparableText(el.innerText || el.textContent || '');
        if (!text || text.length > 700 || !texts.has(text)) continue;

        // Hide the outermost same-text caption-sized wrapper, but stop immediately before any
        // ancestor that contains OpenSub's own overlay/status UI.
        let target = el;
        let parent = el.parentElement;
        let depth = 0;
        while (parent && depth++ < 4) {
          if (touchesOpenSubUi(parent)) break;
          const pr = visibleRect(parent);
          if (!pr || !intersects(pr, vr) || pr.height > vr.height * 0.38 || pr.width > vr.width * 1.15) break;
          const pt = comparableText(parent.innerText || parent.textContent || '');
          if (pt !== text) break;
          target = parent;
          parent = parent.parentElement;
        }
        if (concealPlutoNode(target)) count++;
      }
    }
    return count;
  }

  function applyPlutoSuppression() {
    if (!running) return;
    const resolved = resolveVideoAndTrack();
    if (!resolved) {
      suppressionStats = {
        hiddenTracks: 0,
        shakaCaptionChildren: suppressStandardShakaCaptionChildren(),
        cueMatchedNodes: 0
      };
      return;
    }
    suppressionStats = {
      hiddenTracks: forcePlutoCaptionTracksHidden(resolved.video),
      shakaCaptionChildren: suppressStandardShakaCaptionChildren(),
      cueMatchedNodes: suppressCueMatchedVisuals(resolved.video, resolved.track)
    };
  }

  function schedulePlutoSuppression() {
    if (!running || suppressionScheduled) return;
    suppressionScheduled = true;
    setTimeout(() => {
      suppressionScheduled = false;
      applyPlutoSuppression();
    }, 80);
  }

  function startSuppressionObserver() {
    try {
      if (suppressionObserver) suppressionObserver.disconnect();
      suppressionObserver = new MutationObserver(() => schedulePlutoSuppression());
      suppressionObserver.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true });
    } catch (_) {}
  }

  function stopPlutoSuppression() {
    try { suppressionObserver?.disconnect(); } catch (_) {}
    suppressionObserver = null;
    suppressionScheduled = false;
    for (const [el, prior] of [...suppressedVisualNodes]) {
      try {
        el.classList.remove(PLUTO_NODE_SUPPRESS_CLASS);
        if (prior.visibility) el.style.setProperty('visibility', prior.visibility, prior.visibilityPriority || '');
        else el.style.removeProperty('visibility');
        if (prior.opacity) el.style.setProperty('opacity', prior.opacity, prior.opacityPriority || '');
        else el.style.removeProperty('opacity');
      } catch (_) {}
    }
    suppressedVisualNodes.clear();
    suppressionStats = { hiddenTracks: 0, shakaCaptionChildren: 0, cueMatchedNodes: 0 };
  }

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
    return holder.value.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  function cueKey(cue) {
    return `${Number(cue.start).toFixed(3)}|${Number(cue.end).toFixed(3)}|${cue.text}`;
  }

  function parseTimestamp(value) {
    const text = String(value || '').trim().replace(',', '.');
    let m = text.match(/^(\d+):(\d{2}):(\d{2})\.(\d{3})$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    m = text.match(/^(\d{1,2}):(\d{2})\.(\d{3})$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
    return null;
  }

  function parseSrt(text) {
    const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const out = [];
    for (const block of normalized.split(/\n{2,}/)) {
      const lines = block.split('\n');
      const timeIndex = lines.findIndex(line => line.includes('-->'));
      if (timeIndex < 0) continue;
      const timing = lines[timeIndex].match(/\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{3})/);
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
      .sort((a, b) => a.start - b.start || a.end - b.end)
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

  function visibleVideoCandidates() {
    return [...document.querySelectorAll('video')];
  }

  function resolveVideoAndTrack() {
    if (!binding) return null;
    const videos = visibleVideoCandidates();
    let video = videos[Number(binding.videoIndex)] || null;

    const matchTrack = candidate => {
      if (!candidate) return false;
      if (binding.label && String(candidate.label || '') !== String(binding.label)) return false;
      if (binding.language && String(candidate.language || '') !== String(binding.language)) return false;
      if (binding.kind && String(candidate.kind || '') !== String(binding.kind)) return false;
      return true;
    };

    if (video) {
      const direct = video.textTracks?.[Number(binding.trackIndex)] || null;
      if (direct && (matchTrack(direct) || (!binding.label && !binding.language && !binding.kind))) return { video, track: direct };
      const fallback = [...(video.textTracks || [])].find(matchTrack);
      if (fallback) return { video, track: fallback };
    }

    for (const candidateVideo of videos) {
      const candidateTrack = [...(candidateVideo.textTracks || [])].find(matchTrack);
      if (candidateTrack) return { video: candidateVideo, track: candidateTrack };
    }
    return null;
  }

  function copyTrackCues(track) {
    try {
      if (track.mode === 'disabled') track.mode = 'hidden';
    } catch (_) {}
    const out = [];
    try {
      for (const cue of [...(track.cues || [])]) {
        const text = cleanText(cue.text || '');
        const start = Number(cue.startTime);
        const end = Number(cue.endTime);
        if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
        out.push({ start, end, text });
      }
    } catch (_) {}
    return out;
  }

  async function primeFromSavedEntry() {
    if (!topPageUrl) return;
    const data = await chrome.storage.local.get(LIBRARY_KEY);
    const entry = (data[LIBRARY_KEY] || {})[topPageUrl];
    for (const cue of parseSrt(entry?.sourceText || '')) sourceByKey.set(cueKey(cue), cue);
    for (const cue of parseSrt(entry?.translatedText || '')) {
      // Existing translated cues cannot be keyed by translated text. Match by timing against
      // known source cues when possible; otherwise keep a timing placeholder key.
      const source = [...sourceByKey.values()].find(src => Math.abs(src.start - cue.start) < 0.015 && Math.abs(src.end - cue.end) < 0.015);
      translatedByKey.set(source ? cueKey(source) : `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|*`, cue);
    }
  }

  function translatedCueForSource(sourceCue) {
    const exact = translatedByKey.get(cueKey(sourceCue));
    if (exact) return exact;
    for (const [key, cue] of translatedByKey) {
      if (!key.endsWith('|*')) continue;
      if (Math.abs(cue.start - sourceCue.start) < 0.015 && Math.abs(cue.end - sourceCue.end) < 0.015) return cue;
    }
    return null;
  }

  function scheduleWrite() {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(writeMergedLibrary, WRITE_DEBOUNCE_MS);
  }

  async function writeMergedLibrary() {
    if (!topPageUrl || !binding) return;
    const data = await chrome.storage.local.get(LIBRARY_KEY);
    const library = data[LIBRARY_KEY] || {};
    const existing = library[topPageUrl] || {};
    const sourceCues = [...sourceByKey.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    const translatedCues = sourceCues.map(src => translatedCueForSource(src)).filter(Boolean).sort((a, b) => a.start - b.start || a.end - b.end);
    if (!translatedCues.length) return;

    library[topPageUrl] = {
      ...existing,
      url: topPageUrl,
      title: existing.title || document.title || 'Pluto video',
      sourceLanguage: binding.sourceLanguage || existing.sourceLanguage || 'auto',
      targetLanguage: binding.targetLanguage || existing.targetLanguage || 'en',
      sourceFileName: existing.sourceFileName || `${binding.label || 'Pluto-Shaka'}.srt`,
      sourceText: cuesToSrt(sourceCues),
      translatedText: cuesToSrt(translatedCues),
      cueCount: translatedCues.length,
      enabled: existing.enabled !== false,
      updatedAt: new Date().toISOString(),
      dynamicSource: 'pluto-shaka'
    };
    await chrome.storage.local.set({ [LIBRARY_KEY]: library });
  }

  async function translateCue(sourceCue) {
    const key = cueKey(sourceCue);
    if (translatedCueForSource(sourceCue) || pendingKeys.has(key)) return;
    pendingKeys.add(key);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'opensub-live-translate',
        text: sourceCue.text,
        sourceLanguage: binding?.sourceLanguage || 'auto',
        targetLanguage: binding?.targetLanguage || 'en'
      });
      if (!running || !binding) return;
      if (result?.ok) {
        translatedByKey.set(key, { start: sourceCue.start, end: sourceCue.end, text: String(result.text || sourceCue.text).trim() || sourceCue.text });
        if (result.sourceLanguage && binding.sourceLanguage === 'auto') binding.detectedLanguage = result.sourceLanguage;
        scheduleWrite();
      }
    } catch (_) {
      // A transient translation failure should not stop the watcher. The cue can be retried
      // the next time it appears in Shaka's rolling buffer.
    } finally {
      pendingKeys.delete(key);
    }
  }

  async function processCurrentBuffer() {
    if (!running || translating || !binding) return;
    applyPlutoSuppression();
    const resolved = resolveVideoAndTrack();
    if (!resolved) return;
    const { video, track } = resolved;
    const buffer = copyTrackCues(track);
    if (!buffer.length) return;

    const signature = `${buffer.length}|${buffer[0]?.start?.toFixed(2)}|${buffer.at(-1)?.end?.toFixed(2)}|${Number(video.currentTime || 0).toFixed(1)}`;
    if (signature === lastTrackSignature && Math.abs(Number(video.currentTime || 0) - lastKnownTime) < 1.2) return;
    lastTrackSignature = signature;
    lastKnownTime = Number(video.currentTime || 0);

    for (const cue of buffer) sourceByKey.set(cueKey(cue), cue);

    const now = Number(video.currentTime || 0);
    const untranslated = buffer
      .filter(cue => !translatedCueForSource(cue) && !pendingKeys.has(cueKey(cue)))
      .sort((a, b) => {
        const aActive = a.start <= now + 0.35 && a.end >= now - 0.35 ? 0 : 1;
        const bActive = b.start <= now + 0.35 && b.end >= now - 0.35 ? 0 : 1;
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
      // Translate sequentially so the active cue becomes available as quickly as possible
      // and to avoid flooding Chrome's on-device Translator API after a large seek.
      for (const cue of untranslated) {
        if (!running) break;
        await translateCue(cue);
        // If the viewer seeks while this batch is translating, abandon the old area and let
        // the next poll prioritize cues around the new playback position.
        const latest = resolveVideoAndTrack();
        if (latest?.video && Math.abs(Number(latest.video.currentTime || 0) - now) > 8) break;
      }
    } finally {
      translating = false;
    }
  }

  async function persistBinding() {
    if (!binding || !topPageUrl) return;
    const data = await chrome.storage.local.get(BINDINGS_KEY);
    const all = data[BINDINGS_KEY] || {};
    all[topPageUrl] = { ...binding, pageUrl: topPageUrl, updatedAt: new Date().toISOString() };
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
      targetLanguage: String(newBinding?.targetLanguage || 'en')
    };
    running = true;
    startSuppressionObserver();
    applyPlutoSuppression();
    lastTrackSignature = '';
    lastKnownTime = -1;
    sourceByKey.clear();
    translatedByKey.clear();
    pendingKeys.clear();
    await primeFromSavedEntry();
    try { await chrome.runtime.sendMessage({ type: 'opensub-reset-live-language' }); } catch (_) {}
    if (persist) await persistBinding();
    processCurrentBuffer();
    return { ok: true };
  }

  async function stop({ forget = false } = {}) {
    running = false;
    stopPlutoSuppression();
    binding = null;
    pendingKeys.clear();
    clearTimeout(writeTimer);
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
    if (message.type === 'opensub-pluto-start-track') {
      start(message.binding || {}, { persist: true }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === 'opensub-pluto-stop-track') {
      stop({ forget: Boolean(message.forget) }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === 'opensub-pluto-status') {
      sendResponse({
        ok: true,
        running,
        binding,
        bufferedSourceCues: sourceByKey.size,
        translatedCues: translatedByKey.size,
        suppression: {
          hiddenTracks: suppressionStats.hiddenTracks,
          shakaCaptionChildren: suppressionStats.shakaCaptionChildren,
          cueMatchedNodes: suppressionStats.cueMatchedNodes,
          rememberedNodes: suppressedVisualNodes.size
        }
      });
      return;
    }
  });

  setInterval(() => {
    if (running) processCurrentBuffer();
  }, POLL_MS);

  // Re-enable only the Pluto-specific dynamic binding on revisit. This does not start the
  // generic DOM/live detector and therefore cannot learn Hulu-style stale accessibility text.
  (async () => {
    const context = await getTopContext();
    const url = normalizeUrl(context?.tabUrl || location.href);
    topPageUrl = url;
    const data = await chrome.storage.local.get(BINDINGS_KEY);
    const saved = (data[BINDINGS_KEY] || {})[url];
    if (saved) {
      // Give Pluto/Shaka time to build its media element and TextTrack list.
      setTimeout(() => start(saved, { persist: false }).catch(() => {}), 1400);
    }
  })();
})();

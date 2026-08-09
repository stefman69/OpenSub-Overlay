'use strict';

const LIBRARY_KEY = 'openSubLibrary';
const GLOBAL_KEY = 'openSubGlobal';

const LANGUAGES = [
  ['auto', 'Auto-detect'],
  ['ar', 'Arabic'], ['bg', 'Bulgarian'], ['bn', 'Bengali'], ['cs', 'Czech'], ['da', 'Danish'],
  ['de', 'German'], ['el', 'Greek'], ['en', 'English'], ['es', 'Spanish'], ['fi', 'Finnish'], ['fr', 'French'],
  ['he', 'Hebrew'], ['hi', 'Hindi'], ['hr', 'Croatian'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'],
  ['ja', 'Japanese'], ['kn', 'Kannada'], ['ko', 'Korean'], ['lt', 'Lithuanian'], ['mr', 'Marathi'], ['nl', 'Dutch'],
  ['no', 'Norwegian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'], ['sk', 'Slovak'],
  ['sl', 'Slovenian'], ['sv', 'Swedish'], ['ta', 'Tamil'], ['te', 'Telugu'], ['th', 'Thai'], ['tr', 'Turkish'],
  ['uk', 'Ukrainian'], ['vi', 'Vietnamese'], ['zh', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)']
];

let currentTab = null;
let pageKey = '';
let library = {};
let globalSettings = { enabled: true, subtitleSize: 'medium', hideOriginalCaptions: false, sourceMode: 'html5' };
let sourceCues = [];
let sourceText = '';
let sourceFileName = '';
let detectedTracks = [];
let detectedNetwork = [];
let frameInfo = [];
let bestFrameId = 0;
let busy = false;
let liveActive = false;
let selectedSourceMode = 'html5';

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.href;
  } catch (_) {
    return String(raw || '').split('#')[0];
  }
}

function cleanTitle(title) {
  return String(title || 'Video page').replace(/\s+-\s+Google Chrome$/i, '').trim();
}

function parseTimestamp(value) {
  const text = String(value || '').trim().replace(',', '.');
  let m = text.match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,3})$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4].padEnd(3, '0')}`);
  m = text.match(/^(\d{1,2}):(\d{2})\.(\d{1,3})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3].padEnd(3, '0')}`);
  return null;
}

function parseFlexibleTime(value, keyHint = '') {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (/ms/i.test(keyHint)) return value / 1000;
    return value > 10000 ? value / 1000 : value;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^-?\d+(?:\.\d+)?ms$/i.test(text)) return parseFloat(text) / 1000;
  if (/^-?\d+(?:\.\d+)?s$/i.test(text)) return parseFloat(text);
  if (/^-?\d+(?:\.\d+)?m$/i.test(text)) return parseFloat(text) * 60;
  if (/^-?\d+(?:\.\d+)?h$/i.test(text)) return parseFloat(text) * 3600;
  const normalized = text.replace(',', '.');
  let m = normalized.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
  m = normalized.match(/^(\d{1,2}):(\d{2})(?:\.(\d+))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0);
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    const n = Number(normalized);
    if (/ms/i.test(keyHint)) return n / 1000;
    return n > 10000 ? n / 1000 : n;
  }
  return null;
}

function cleanSubtitleText(text) {
  const holder = document.createElement('textarea');
  holder.innerHTML = String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  return holder.value.replace(/\u200b/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function parseSrtVtt(input) {
  const normalized = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trimEnd());
    const timeIndex = lines.findIndex(line => line.includes('-->'));
    if (timeIndex < 0) continue;
    const m = lines[timeIndex].match(/\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})/);
    if (!m) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start === null || end === null || end < start) continue;
    const text = cleanSubtitleText(lines.slice(timeIndex + 1).join('\n'));
    if (!text || /^NOTE(?:\s|$)/i.test(text)) continue;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function parseTtml(input) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(input || ''), 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  const nodes = [...doc.getElementsByTagNameNS('*', 'p')];
  const cues = [];
  for (const p of nodes) {
    const beginRaw = p.getAttribute('begin');
    const endRaw = p.getAttribute('end');
    const durRaw = p.getAttribute('dur');
    const start = parseFlexibleTime(beginRaw, 'begin');
    let end = parseFlexibleTime(endRaw, 'end');
    const dur = parseFlexibleTime(durRaw, 'dur');
    if (end === null && start !== null && dur !== null) end = start + dur;
    if (start === null || end === null || end < start) continue;
    const text = cleanSubtitleText(p.innerHTML.replace(/<br\s*\/?\s*>/gi, '\n'));
    if (text) cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function parseSami(input) {
  const text = String(input || '');
  const matches = [...text.matchAll(/<sync\b[^>]*\bstart\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\b|$)/ig)];
  const cues = [];
  for (let i = 0; i < matches.length; i++) {
    const start = Number(matches[i][1]) / 1000;
    const next = matches[i + 1] ? Number(matches[i + 1][1]) / 1000 : start + 4;
    const body = matches[i][2].replace(/<br\s*\/?>/gi, '\n');
    const caption = cleanSubtitleText(body).replace(/&nbsp;/gi, ' ').trim();
    if (caption) cues.push({ start, end: Math.max(start + 0.1, next), text: caption });
  }
  return cues;
}

function jsonText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (Array.isArray(obj.segs)) return cleanSubtitleText(obj.segs.map(s => s?.utf8 || s?.text || '').join(''));
  for (const key of ['text', 'caption', 'subtitle', 'content', 'payload', 'utf8', 'value']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) return cleanSubtitleText(obj[key]);
  }
  return '';
}

function parseJsonCues(input) {
  let data;
  try { data = typeof input === 'string' ? JSON.parse(input) : input; } catch (_) { return []; }
  const cues = [];
  const seen = new Set();

  function add(start, end, text) {
    if (start === null || end === null || !text || end < start) return;
    const key = `${start.toFixed(3)}|${end.toFixed(3)}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    cues.push({ start, end, text });
  }

  function visit(node) {
    if (!node || typeof node !== 'object') return;

    if (node.tStartMs !== undefined && (node.dDurationMs !== undefined || node.dDuration !== undefined)) {
      const start = parseFlexibleTime(node.tStartMs, 'tStartMs');
      const dur = parseFlexibleTime(node.dDurationMs ?? node.dDuration, node.dDurationMs !== undefined ? 'durationMs' : 'duration');
      add(start, start !== null && dur !== null ? start + dur : null, jsonText(node));
    } else {
      const startKeys = ['startTimeMs','startMs','start_time_ms','startTime','start_time','start','begin','from','offsetMs','offset'];
      const endKeys = ['endTimeMs','endMs','end_time_ms','endTime','end_time','end','to'];
      const durKeys = ['durationMs','duration_ms','dDurationMs','duration','dur'];
      const startKey = startKeys.find(k => node[k] !== undefined);
      const endKey = endKeys.find(k => node[k] !== undefined);
      const durKey = durKeys.find(k => node[k] !== undefined);
      if (startKey) {
        const start = parseFlexibleTime(node[startKey], startKey);
        let end = endKey ? parseFlexibleTime(node[endKey], endKey) : null;
        if (end === null && durKey && start !== null) {
          const dur = parseFlexibleTime(node[durKey], durKey);
          if (dur !== null) end = start + dur;
        }
        add(start, end, jsonText(node));
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else {
      for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
    }
  }

  visit(data);
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function parseUniversalSubtitle(input, meta = {}) {
  const text = String(input || '');
  let cues = parseSrtVtt(text);
  if (cues.length) return { cues, format: /WEBVTT/i.test(text.slice(0, 300)) ? 'WebVTT' : 'SRT' };

  if (/<tt(?:\s|>)/i.test(text) || /ttml|dfxp/i.test(`${meta.url || ''} ${meta.contentType || ''} ${meta.format || ''}`)) {
    cues = parseTtml(text);
    if (cues.length) return { cues, format: 'TTML/DFXP' };
  }

  if (/<sync\b/i.test(text) || /sami|\.smi/i.test(`${meta.url || ''} ${meta.format || ''}`)) {
    cues = parseSami(text);
    if (cues.length) return { cues, format: 'SAMI' };
  }

  if (/^[\s\r\n]*[\[{]/.test(text) || /json/i.test(`${meta.contentType || ''} ${meta.format || ''}`)) {
    cues = parseJsonCues(text);
    if (cues.length) return { cues, format: 'JSON timed text' };
  }

  if (/^#EXTM3U/m.test(text)) {
    throw new Error('This is an HLS playlist, not the caption text itself. Keep the site captions playing a little longer and Refresh detection; OpenSub is looking for the VTT/TTML caption segments referenced by this playlist.');
  }

  throw new Error('OpenSub captured this player resource, but could not recognize timed subtitle cues inside it yet.');
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(r).padStart(3,'0')}`;
}

function cuesToSrt(cues) {
  return cues.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`).join('\n\n') + '\n';
}

function safeFileName(value) {
  return String(value || 'subtitles').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'subtitles';
}

function setMessage(text, error = false) {
  const el = document.getElementById('actionMessage');
  el.textContent = text || '';
  el.style.color = error ? '#ff9ba4' : '#cdd4df';
}

function setBusy(value) {
  busy = value;
  for (const id of ['translateSave', 'saveOriginal', 'captureTrack', 'captureNetwork', 'refreshDetection']) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (id === 'captureTrack') el.disabled = value || !document.getElementById('siteTrack').value;
    else if (id === 'captureNetwork') el.disabled = value || !document.getElementById('networkTrack').value;
    else el.disabled = value;
  }
}

function progress(pct, text) {
  document.getElementById('progressWrap').classList.remove('hidden');
  document.getElementById('progressBar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  document.getElementById('progressText').textContent = text || '';
}

function hideProgress() {
  document.getElementById('progressWrap').classList.add('hidden');
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressText').textContent = '';
}

async function saveLibrary() {
  await chrome.storage.local.set({ [LIBRARY_KEY]: library });
}

async function notifyTab() {
  if (!currentTab?.id) return;
  try { await chrome.tabs.sendMessage(currentTab.id, { type: 'opensub-reload' }); } catch (_) {}
}

function populateLanguages() {
  const source = document.getElementById('sourceLanguage');
  const target = document.getElementById('targetLanguage');
  for (const [code, name] of LANGUAGES) {
    source.add(new Option(name, code));
    if (code !== 'auto') target.add(new Option(name, code));
  }
  source.value = 'auto';
  target.value = 'en';
}

function setSourceMode(mode, { persist = false } = {}) {
  selectedSourceMode = mode === 'live' ? 'live' : 'html5';
  globalSettings.sourceMode = selectedSourceMode;

  document.getElementById('sourceHtml5').classList.toggle('selected', selectedSourceMode === 'html5');
  document.getElementById('sourceLive').classList.toggle('selected', selectedSourceMode === 'live');
  document.getElementById('html5Panel').classList.toggle('hidden', selectedSourceMode !== 'html5');
  document.getElementById('trackActions').classList.toggle('hidden', selectedSourceMode !== 'html5');
  document.getElementById('livePanel').classList.toggle('hidden', selectedSourceMode !== 'live');
  document.getElementById('liveActions').classList.toggle('hidden', selectedSourceMode !== 'live');
  document.getElementById('sourcePanelTitle').textContent = selectedSourceMode === 'live'
    ? 'Live-caption settings'
    : 'HTML5 / complete-track settings';

  if (persist) chrome.storage.local.set({ [GLOBAL_KEY]: globalSettings }).catch(() => {});
}

function setSourceBadge(id, text, state = 'off') {
  const badge = document.getElementById(id);
  badge.textContent = text;
  badge.classList.remove('active', 'ready', 'running', 'off');
  badge.classList.add(state);
}

function renderSavedEntry() {
  const entry = library[pageKey];
  const card = document.getElementById('controlsCard');
  if (!entry) {
    card.classList.add('hidden');
    document.getElementById('savedState').textContent = 'No saved OpenSub track for this page yet.';
    return;
  }
  card.classList.remove('hidden');
  document.getElementById('entryEnabled').checked = entry.enabled !== false;
  document.getElementById('offsetValue').textContent = `${Number(entry.offset || 0) >= 0 ? '+' : ''}${Number(entry.offset || 0).toFixed(2)}s`;
  const language = entry.translatedText ? `${entry.sourceLanguage || '?'} → ${entry.targetLanguage || '?'}` : `${entry.sourceLanguage || 'original'}`;
  document.getElementById('savedState').textContent = `Saved track: ${entry.cueCount || '?'} cues • ${language}`;
  document.getElementById('downloadTranslation').disabled = !entry.translatedText;
  document.getElementById('downloadSource').disabled = !entry.sourceText;
}

async function inspectFrames() {
  if (!currentTab?.id) return [];
  let baseResults = [];
  try {
    baseResults = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: () => {
        const videos = [...document.querySelectorAll('video')];
        return {
          frameUrl: location.href,
          videos: videos.map((video, videoIndex) => {
            const r = video.getBoundingClientRect();
            const textTracks = [...video.textTracks].map((track, trackIndex) => ({
              videoIndex,
              trackIndex,
              label: track.label || `Track ${trackIndex + 1}`,
              language: track.language || '',
              kind: track.kind || '',
              mode: track.mode || '',
              cueCount: track.cues ? track.cues.length : null
            }));
            const elements = [...video.querySelectorAll('track')].map((track, trackIndex) => ({
              videoIndex,
              trackIndex,
              label: track.label || `Track ${trackIndex + 1}`,
              language: track.srclang || '',
              kind: track.kind || '',
              src: track.src || ''
            }));
            return {
              videoIndex,
              width: Math.round(r.width),
              height: Math.round(r.height),
              area: Math.round(Math.max(0, r.width) * Math.max(0, r.height)),
              playing: !video.paused && !video.ended,
              textTracks,
              elements
            };
          })
        };
      }
    });
  } catch (error) {
    setMessage(`Could not inspect this page: ${error.message}`, true);
    return [];
  }

  for (const result of baseResults) {
    try {
      result.extra = await chrome.tabs.sendMessage(currentTab.id, { type: 'opensub-frame-inspect' }, { frameId: result.frameId });
    } catch (_) {
      result.extra = null;
    }
  }
  return baseResults;
}

function shortResourceName(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return `${u.hostname} / ${tail}`.slice(0, 78);
  } catch (_) {
    return String(url || 'captured captions').slice(0, 78);
  }
}

function renderDetectedFrames(results) {
  frameInfo = [];
  detectedTracks = [];
  detectedNetwork = [];
  const allVideos = [];

  for (const result of results) {
    const frameId = result.frameId;
    const frameUrl = result.result?.frameUrl || result.extra?.frameUrl || '';
    const extra = result.extra || {};
    const videos = result.result?.videos || [];
    for (const video of videos) {
      const item = { frameId, frameUrl, ...video, extra };
      allVideos.push(item);
      for (const track of video.textTracks || []) {
        detectedTracks.push({ frameId, frameUrl, ...track, src: (video.elements || [])[track.trackIndex]?.src || '' });
      }
    }
    for (const resource of extra.networkCandidates || []) {
      if (!detectedNetwork.some(x => x.frameId === frameId && x.id === resource.id)) detectedNetwork.push({ frameId, frameUrl, ...resource });
    }
    frameInfo.push({ frameId, frameUrl, extra, videos });
  }

  allVideos.sort((a, b) => Number(b.playing) - Number(a.playing) || Number(b.area || 0) - Number(a.area || 0));
  bestFrameId = allVideos[0]?.frameId ?? 0;

  const videoState = document.getElementById('videoState');
  if (!allVideos.length) videoState.textContent = 'No HTML5 video element is visible yet. Start/open the site player, then Refresh detection.';
  else {
    const playing = allVideos.filter(v => v.playing).length;
    videoState.textContent = `✓ ${allVideos.length} video player${allVideos.length === 1 ? '' : 's'} detected across this tab${playing ? ` • ${playing} playing` : ''}.`;
  }

  const trackSelect = document.getElementById('siteTrack');
  trackSelect.innerHTML = '';
  if (!detectedTracks.length) {
    trackSelect.add(new Option('No exposed HTML5 subtitle tracks detected', ''));
    document.getElementById('captureTrack').disabled = true;
  } else {
    trackSelect.add(new Option('Choose an HTML5 subtitle track…', ''));
    detectedTracks.forEach((track, i) => {
      const label = `${track.label || 'Subtitle'}${track.language ? ` [${track.language}]` : ''}${track.mode === 'showing' ? ' • active' : ''}${track.cueCount !== null ? ` • ${track.cueCount} cues` : ''}`;
      trackSelect.add(new Option(label, String(i)));
    });
    document.getElementById('captureTrack').disabled = false;
  }

  detectedNetwork.sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
  const networkSelect = document.getElementById('networkTrack');
  networkSelect.innerHTML = '';
  if (!detectedNetwork.length) {
    networkSelect.add(new Option('No caption resources captured yet', ''));
    document.getElementById('captureNetwork').disabled = true;
  } else {
    networkSelect.add(new Option('Choose a captured caption resource…', ''));
    detectedNetwork.forEach((resource, i) => {
      const kb = Math.max(1, Math.round(Number(resource.size || 0) / 1024));
      networkSelect.add(new Option(`${resource.format || 'Timed text'} • ${kb} KB • ${shortResourceName(resource.url)}`, String(i)));
    });
    document.getElementById('captureNetwork').disabled = false;
  }

  const bestFrame = frameInfo.find(f => f.frameId === bestFrameId) || frameInfo[0];
  const dom = bestFrame?.extra;
  liveActive = Boolean(dom?.liveActive);
  document.getElementById('startLive').disabled = liveActive || !allVideos.length;
  document.getElementById('stopLive').disabled = !liveActive;

  const domState = document.getElementById('domCaptionState');
  if (dom?.domCaptionVisible) {
    domState.textContent = `✓ Custom/DOM caption text detected: “${String(dom.domCaptionSample || '').replace(/\s+/g, ' ').slice(0, 110)}”${liveActive ? ' • live translation running' : ''}`;
  } else if (liveActive) {
    domState.textContent = 'Live translation is running. OpenSub is waiting for the next visible site caption.';
  } else {
    domState.textContent = 'No custom caption text seen yet. Turn the site’s subtitles on and let a line appear, then Refresh detection.';
  }

  const html5Active = detectedTracks.some(track => track.mode === 'showing');
  const html5Available = detectedTracks.length > 0 || detectedNetwork.length > 0;
  const liveVisible = Boolean(dom?.domCaptionVisible);

  if (html5Active) setSourceBadge('html5SourceBadge', 'Active', 'active');
  else if (detectedTracks.length) setSourceBadge('html5SourceBadge', 'Available', 'ready');
  else if (detectedNetwork.length) setSourceBadge('html5SourceBadge', 'Captured', 'ready');
  else setSourceBadge('html5SourceBadge', 'Not detected', 'off');

  if (liveActive) setSourceBadge('liveSourceBadge', liveVisible ? 'Active + running' : 'Running', 'running');
  else if (liveVisible) setSourceBadge('liveSourceBadge', 'Active', 'active');
  else setSourceBadge('liveSourceBadge', 'Not detected', 'off');

  const captureState = document.getElementById('captureState');
  const states = [
    `HTML5/track: ${html5Active ? 'active' : (html5Available ? 'available' : 'not detected')}`,
    `Live: ${liveVisible ? 'active' : (liveActive ? 'translation running' : 'not detected')}`
  ];
  captureState.textContent = states.join(' • ');
}

async function captureTrack(index) {
  const trackInfo = detectedTracks[Number(index)];
  if (!trackInfo) throw new Error('Choose an HTML5 subtitle track first.');
  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, frameIds: [trackInfo.frameId] },
    args: [trackInfo.videoIndex, trackInfo.trackIndex],
    func: async (videoIndex, trackIndex) => {
      const video = [...document.querySelectorAll('video')][videoIndex];
      if (!video) return { error: 'Video element disappeared.' };
      const track = video.textTracks[trackIndex];
      if (!track) return { error: 'Subtitle track disappeared.' };
      const oldMode = track.mode;
      try { if (track.mode === 'disabled') track.mode = 'hidden'; } catch (_) {}
      const deadline = Date.now() + 2600;
      while ((!track.cues || !track.cues.length) && Date.now() < deadline) await new Promise(r => setTimeout(r, 120));
      const cues = track.cues ? [...track.cues].map(c => ({ start: c.startTime, end: c.endTime, text: c.text || '' })) : [];
      try { if (oldMode === 'disabled') track.mode = oldMode; } catch (_) {}
      return { cues, language: track.language || '', label: track.label || '' };
    }
  });
  const result = results?.[0]?.result;
  if (result?.error) throw new Error(result.error);
  if (!result?.cues?.length) throw new Error('The HTML5 track exists, but its cue list is inaccessible. Try a captured timed-text resource or Live translation below.');
  sourceCues = result.cues.map(c => ({ start: Number(c.start), end: Number(c.end), text: cleanSubtitleText(c.text) })).filter(c => c.text);
  sourceText = cuesToSrt(sourceCues);
  sourceFileName = `${result.label || 'site-subtitles'}.srt`;
  if (result.language && LANGUAGES.some(([code]) => code === result.language)) document.getElementById('sourceLanguage').value = result.language;
}

async function captureNetworkResource(index) {
  const info = detectedNetwork[Number(index)];
  if (!info) throw new Error('Choose a captured timed-text resource first.');
  const result = await chrome.tabs.sendMessage(currentTab.id, { type: 'opensub-get-network-candidate', id: info.id }, { frameId: info.frameId });
  if (!result?.ok) throw new Error(result?.error || 'Could not retrieve that captured resource.');
  const parsed = parseUniversalSubtitle(result.text, result);
  sourceCues = parsed.cues;
  sourceText = cuesToSrt(sourceCues);
  sourceFileName = `${parsed.format.replace(/[^a-z0-9]+/gi, '_') || 'captured'}_subtitles.srt`;
}

async function detectLanguage(cues) {
  if (!('LanguageDetector' in self)) throw new Error('Chrome Language Detector API is unavailable. Pick the source language manually.');
  const sample = cues.slice(0, 120).map(c => c.text).join(' ').slice(0, 12000);
  if (!sample.trim()) throw new Error('There is no subtitle text to detect.');
  progress(2, 'Loading Chrome language detector…');
  const detector = await LanguageDetector.create({
    monitor(m) {
      m.addEventListener('downloadprogress', e => progress(Math.max(2, e.loaded * 15), `Downloading language detector… ${Math.round(e.loaded * 100)}%`));
    }
  });
  const results = await detector.detect(sample);
  detector.destroy?.();
  const best = results?.[0];
  if (!best?.detectedLanguage) throw new Error('Chrome could not identify the subtitle language.');
  return best.detectedLanguage;
}

async function translateCues(cues, sourceLanguage, targetLanguage) {
  if (!('Translator' in self)) throw new Error('Chrome Translator API is unavailable. Update desktop Chrome and try again.');
  const availability = await Translator.availability({ sourceLanguage, targetLanguage });
  if (availability === 'unavailable') throw new Error(`Chrome does not currently support ${sourceLanguage} → ${targetLanguage} on this computer.`);
  progress(4, `Preparing ${sourceLanguage} → ${targetLanguage} translator…`);
  const translator = await Translator.create({
    sourceLanguage,
    targetLanguage,
    monitor(m) {
      m.addEventListener('downloadprogress', e => progress(4 + e.loaded * 16, `Downloading translation model… ${Math.round(e.loaded * 100)}%`));
    }
  });
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    const translated = await translator.translate(cues[i].text);
    out.push({ start: cues[i].start, end: cues[i].end, text: String(translated || '').trim() || cues[i].text });
    if (i % 3 === 0 || i === cues.length - 1) progress(20 + ((i + 1) / cues.length) * 78, `Translating subtitle ${i + 1} of ${cues.length}…`);
  }
  translator.destroy?.();
  return out;
}

async function createEntry({ translatedCues = null, sourceLanguage = '', targetLanguage = '' }) {
  const title = cleanTitle(currentTab?.title || 'Video page');
  const entry = library[pageKey] || {};
  library[pageKey] = {
    ...entry,
    pageUrl: pageKey,
    title,
    enabled: true,
    offset: Number(entry.offset || 0),
    fontScale: Number(entry.fontScale || 0.045),
    sourceLanguage: sourceLanguage || entry.sourceLanguage || '',
    targetLanguage: translatedCues ? targetLanguage : '',
    sourceFileName: sourceFileName || entry.sourceFileName || 'subtitles.srt',
    sourceText: sourceText || cuesToSrt(sourceCues),
    translatedText: translatedCues ? cuesToSrt(translatedCues) : '',
    cueCount: sourceCues.length,
    updatedAt: new Date().toISOString()
  };
  await saveLibrary();
  await notifyTab();
  renderSavedEntry();
}

function downloadText(text, fileName) {
  const blob = new Blob([text], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(fileName);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function refreshDetection() {
  setMessage('Refreshing player and caption detection…');
  const frames = await inspectFrames();
  renderDetectedFrames(frames);
  setMessage('Detection refreshed.');
}

async function init() {
  populateLanguages();
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageKey = normalizeUrl(currentTab?.url || '');
  document.getElementById('pageTitle').textContent = cleanTitle(currentTab?.title || 'Current page');
  document.getElementById('pageUrl').textContent = pageKey;
  const data = await chrome.storage.local.get([LIBRARY_KEY, GLOBAL_KEY]);
  library = data[LIBRARY_KEY] || {};
  globalSettings = { enabled: true, subtitleSize: 'medium', hideOriginalCaptions: false, sourceMode: 'html5', ...(data[GLOBAL_KEY] || {}) };
  document.getElementById('globalEnabled').checked = globalSettings.enabled !== false;
  document.getElementById('subtitleSize').value = globalSettings.subtitleSize || 'medium';
  document.getElementById('hideOriginalCaptions').checked = Boolean(globalSettings.hideOriginalCaptions);
  setSourceMode(globalSettings.sourceMode || 'html5');
  renderSavedEntry();
  await refreshDetection();
  setMessage('');
}

document.getElementById('sourceHtml5').addEventListener('click', () => setSourceMode('html5', { persist: true }));
document.getElementById('sourceLive').addEventListener('click', () => setSourceMode('live', { persist: true }));

document.getElementById('subtitleFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseUniversalSubtitle(text, { url: file.name });
    sourceCues = parsed.cues;
    sourceText = cuesToSrt(parsed.cues);
    sourceFileName = file.name;
    document.getElementById('sourceState').textContent = `✓ Loaded ${file.name} • ${parsed.cues.length} cues • ${parsed.format}`;
    setMessage('');
  } catch (error) {
    setMessage(error.message, true);
  }
});

document.getElementById('siteTrack').addEventListener('change', e => {
  document.getElementById('captureTrack').disabled = busy || !e.target.value;
});

document.getElementById('networkTrack').addEventListener('change', e => {
  document.getElementById('captureNetwork').disabled = busy || !e.target.value;
});

document.getElementById('captureTrack').addEventListener('click', async () => {
  const index = document.getElementById('siteTrack').value;
  if (index === '') return;
  setBusy(true);
  setMessage('Capturing the HTML5 subtitle track…');
  try {
    await captureTrack(index);
    document.getElementById('sourceState').textContent = `✓ Captured ${sourceFileName} • ${sourceCues.length} cues`;
    setMessage('Track captured. Translate it or overlay it as-is.');
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setBusy(false);
  }
});

document.getElementById('captureNetwork').addEventListener('click', async () => {
  const index = document.getElementById('networkTrack').value;
  if (index === '') return;
  setBusy(true);
  setMessage('Reading the captured timed-text resource…');
  try {
    await captureNetworkResource(index);
    document.getElementById('sourceState').textContent = `✓ Captured network subtitles • ${sourceCues.length} cues`;
    setMessage('Timed-text resource parsed successfully. Translate it or overlay it as-is.');
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setBusy(false);
  }
});

document.getElementById('translateSave').addEventListener('click', async () => {
  if (!sourceCues.length) return setMessage('Choose/capture a complete subtitle track first, or use Live translation for custom rendered captions.', true);
  setBusy(true);
  hideProgress();
  try {
    let sourceLanguage = document.getElementById('sourceLanguage').value;
    const targetLanguage = document.getElementById('targetLanguage').value;
    if (sourceLanguage === 'auto') {
      sourceLanguage = await detectLanguage(sourceCues);
      setMessage(`Detected source language: ${sourceLanguage}`);
    }
    if (sourceLanguage === targetLanguage) throw new Error('Source and target languages are the same. Use “Overlay without translating” instead.');
    const translated = await translateCues(sourceCues, sourceLanguage, targetLanguage);
    await createEntry({ translatedCues: translated, sourceLanguage, targetLanguage });
    progress(100, `Done — ${translated.length} cues translated and saved.`);
    setMessage(`✓ Saved ${sourceLanguage} → ${targetLanguage} subtitles for this page.`);
  } catch (error) {
    setMessage(`Translation failed: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
});

document.getElementById('saveOriginal').addEventListener('click', async () => {
  if (!sourceCues.length) return setMessage('Choose/capture a complete subtitle track first.', true);
  setBusy(true);
  try {
    let lang = document.getElementById('sourceLanguage').value;
    if (lang === 'auto') lang = '';
    await createEntry({ translatedCues: null, sourceLanguage: lang, targetLanguage: '' });
    setMessage(`✓ Saved ${sourceCues.length} original subtitle cues for this page.`);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setBusy(false);
  }
});

document.getElementById('startLive').addEventListener('click', async () => {
  if (!currentTab?.id) return;
  const sourceLanguage = document.getElementById('sourceLanguage').value;
  const targetLanguage = document.getElementById('targetLanguage').value;
  if (sourceLanguage === targetLanguage) return setMessage('For live translation, choose a different target language.', true);
  try {
    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: 'opensub-start-live', sourceLanguage, targetLanguage
    }, { frameId: bestFrameId });
    if (!result?.ok) throw new Error(result?.error || 'Could not start live translation.');
    liveActive = true;
    document.getElementById('startLive').disabled = true;
    document.getElementById('stopLive').disabled = false;
    setMessage('✓ Live translation started. You can close this popup; OpenSub will keep translating visible site captions in the background.');
  } catch (error) {
    setMessage(`Could not start live translation: ${error.message}`, true);
  }
});

document.getElementById('stopLive').addEventListener('click', async () => {
  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: 'opensub-stop-live' }, { frameId: bestFrameId });
    liveActive = false;
    document.getElementById('startLive').disabled = false;
    document.getElementById('stopLive').disabled = true;
    setMessage('Live translation stopped.');
  } catch (error) {
    setMessage(error.message, true);
  }
});

document.getElementById('refreshDetection').addEventListener('click', refreshDetection);



document.getElementById('globalEnabled').addEventListener('change', async e => {
  globalSettings.enabled = e.target.checked;
  await chrome.storage.local.set({ [GLOBAL_KEY]: globalSettings });
  await notifyTab();
});

document.getElementById('subtitleSize').addEventListener('change', async e => {
  globalSettings.subtitleSize = e.target.value || 'medium';
  await chrome.storage.local.set({ [GLOBAL_KEY]: globalSettings });
  await notifyTab();
  setMessage(`Subtitle size set to ${e.target.options[e.target.selectedIndex]?.text || 'Medium'}.`);
});

document.getElementById('hideOriginalCaptions').addEventListener('change', async e => {
  globalSettings.hideOriginalCaptions = e.target.checked;
  await chrome.storage.local.set({ [GLOBAL_KEY]: globalSettings });
  await notifyTab();
  setMessage(e.target.checked
    ? 'Original/site subtitles will be hidden while OpenSub is active when the player allows it.'
    : 'Original/site subtitles restored.');
});

document.getElementById('entryEnabled').addEventListener('change', async e => {
  if (!library[pageKey]) return;
  library[pageKey].enabled = e.target.checked;
  await saveLibrary();
  await notifyTab();
});

async function adjustOffset(delta) {
  if (!library[pageKey]) return;
  library[pageKey].offset = Math.round((Number(library[pageKey].offset || 0) + delta) * 100) / 100;
  await saveLibrary();
  await notifyTab();
  renderSavedEntry();
}

document.getElementById('minusOffset').addEventListener('click', () => adjustOffset(-0.25));
document.getElementById('plusOffset').addEventListener('click', () => adjustOffset(0.25));

document.getElementById('downloadSource').addEventListener('click', () => {
  const e = library[pageKey];
  if (!e?.sourceText) return;
  downloadText(e.sourceText, `${safeFileName(e.title)}.${e.sourceLanguage || 'source'}.srt`);
});

document.getElementById('downloadTranslation').addEventListener('click', () => {
  const e = library[pageKey];
  if (!e?.translatedText) return;
  downloadText(e.translatedText, `${safeFileName(e.title)}.${e.targetLanguage || 'translated'}.srt`);
});

document.getElementById('removeEntry').addEventListener('click', async () => {
  delete library[pageKey];
  await saveLibrary();
  await notifyTab();
  renderSavedEntry();
  setMessage('Removed the saved subtitles for this page.');
});

document.getElementById('openLibrary').addEventListener('click', () => chrome.runtime.openOptionsPage());

init().catch(error => setMessage(`Initialization error: ${error.message}`, true));

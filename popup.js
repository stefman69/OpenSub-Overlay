'use strict';

const LIBRARY_KEY = 'openSubLibrary';
const GLOBAL_KEY = 'openSubGlobal';
const SITE_TIMING_KEY = 'openSubSiteTiming';

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
let globalSettings = { enabled: true, subtitleSize: 'medium', hideOriginalCaptions: false, sourceMode: 'html5', sourceLanguage: 'auto', targetLanguage: 'en' };
let sourceCues = [];
let sourceText = '';
let sourceFileName = '';
// Sentence-aware batching is deliberately limited to complete file/network subtitle sources.
// Live DOM captions and rolling/replaced HTML5 tracks keep their low-latency cue-by-cue paths.
let sourceInputKind = 'none'; // none | file | network | html5
let translationMethod = 'chrome';
let providedTranslationCues = [];
let providedTranslationText = '';
let providedTranslationFileName = '';
let providedTranslationAlignment = null;
let siteTimingProfiles = {};
let detectedTracks = [];
let detectedNetwork = [];
let frameInfo = [];
let bestFrameId = 0;
let busy = false;
let liveActive = false;
let selectedSourceMode = 'html5';
let loadedDetectedSelection = '';
let selectionLoadSerial = 0;

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

function isPlutoPage() {
  try {
    const host = new URL(currentTab?.url || '').hostname.toLowerCase();
    return host === 'pluto.tv' || host.endsWith('.pluto.tv');
  } catch (_) {
    return false;
  }
}

function isPlutoUrl(raw) {
  try {
    const host = new URL(raw || '').hostname.toLowerCase();
    return host === 'pluto.tv' || host.endsWith('.pluto.tv');
  } catch (_) {
    return false;
  }
}

function isMissingRuntimeReceiver(error) {
  const message = String(error?.message || error || '');
  return /receiving end does not exist|could not establish connection/i.test(message);
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pingOpenSubRuntime(frameId) {
  try {
    const result = await chrome.tabs.sendMessage(
      currentTab.id,
      { type: 'opensub-frame-inspect' },
      { frameId }
    );
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

async function injectOpenSubRuntime(frameId, frameUrl = '') {
  if (!currentTab?.id) return false;

  // A tab that was already open when the extension was reloaded can keep the old page while
  // losing its extension message receiver. Reinstall the exact same runtime into that frame;
  // do not reload or alter the site's player state.
  try {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: currentTab.id, frameIds: [frameId] },
        files: ['content.css']
      });
    } catch (_) {}

    const isolatedFiles = ['content.js', 'rolling_tracks.js', 'caption_guard.js', 'subtitle_discovery.js'];
    if (isPlutoUrl(frameUrl || currentTab.url)) isolatedFiles.push('pluto_shaka.js');

    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, frameIds: [frameId] },
      files: isolatedFiles
    });

    // Restore the MAIN-world subtitle network observer too. It is internally idempotent, so
    // a surviving probe from the old extension instance will simply ignore this reinjection.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id, frameIds: [frameId] },
        files: ['page_probe.js'],
        world: 'MAIN'
      });
    } catch (_) {}

    await waitMs(160);
    const ping = await pingOpenSubRuntime(frameId);
    if (!ping.ok) return false;

    // Ask any surviving/new MAIN-world probe to replay caption responses from this exact page
    // session so recovery does not unnecessarily lose already-captured subtitle resources.
    try {
      await chrome.tabs.sendMessage(
        currentTab.id,
        { type: 'opensub-reset-caption-session' },
        { frameId }
      );
    } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureOpenSubRuntime() {
  if (!currentTab?.id) return 0;
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: () => ({
        frameUrl: location.href,
        hasVideo: Boolean(document.querySelector('video'))
      })
    });
  } catch (_) {
    return 0;
  }

  // Heal the top document and any frame actually hosting video. Avoid touching unrelated ad,
  // login, and analytics frames merely because they share the tab.
  const targets = frames.filter(item => item.frameId === 0 || item.result?.hasVideo);
  let recovered = 0;
  for (const item of targets) {
    let ping = await pingOpenSubRuntime(item.frameId);
    if (ping.ok) continue;
    if (!isMissingRuntimeReceiver(ping.error)) continue;

    // Content scripts can still be finishing document_start on a freshly navigated page. Give
    // them one short grace period before concluding this is genuinely a stale extension tab.
    await waitMs(140);
    ping = await pingOpenSubRuntime(item.frameId);
    if (ping.ok) continue;
    if (!isMissingRuntimeReceiver(ping.error)) continue;

    if (await injectOpenSubRuntime(item.frameId, item.result?.frameUrl || '')) recovered++;
  }

  if (recovered) await waitMs(180);
  return recovered;
}

async function startPlutoDynamicWatcher(sourceLanguage, targetLanguage) {
  if (!isPlutoPage()) return { ok: false, skipped: true };
  const match = String(loadedDetectedSelection || '').match(/^html5:(\d+)$/);
  if (!match) return { ok: false, skipped: true };
  const trackInfo = detectedTracks[Number(match[1])];
  if (!trackInfo) return { ok: false, skipped: true };
  try {
    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: 'opensub-pluto-start-track',
      binding: {
        pageUrl: pageKey,
        videoIndex: trackInfo.videoIndex,
        trackIndex: trackInfo.trackIndex,
        label: trackInfo.label || '',
        language: trackInfo.language || '',
        kind: trackInfo.kind || '',
        sourceLanguage: sourceLanguage || 'auto',
        targetLanguage: targetLanguage || 'en'
      }
    }, { frameId: trackInfo.frameId });
    return result || { ok: false };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function rollingFrameIds() {
  if (!currentTab?.id) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: () => location.href
    });
    return [...new Set(results.map(result => result.frameId).filter(Number.isInteger))];
  } catch (_) {
    return [];
  }
}

async function stopUniversalRollingWatchers({ forget = false } = {}) {
  const frameIds = await rollingFrameIds();
  await Promise.all(frameIds.map(frameId => chrome.tabs.sendMessage(
    currentTab.id,
    { type: 'opensub-rolling-stop-track', forget },
    { frameId }
  ).catch(() => null)));
}

async function startUniversalRollingWatcher(sourceLanguage, targetLanguage = '') {
  // Pluto already has its proven Shaka-specific rolling watcher plus original-caption
  // suppression. Every other explicitly selected HTML5 caption/subtitle track uses this
  // universal watcher.
  if (isPlutoPage()) return { ok: false, skipped: true, reason: 'pluto-specialized' };
  const match = String(loadedDetectedSelection || '').match(/^html5:(\d+)$/);
  if (!match) return { ok: false, skipped: true, reason: 'not-html5' };
  const trackInfo = detectedTracks[Number(match[1])];
  if (!trackInfo) return { ok: false, skipped: true, reason: 'track-missing' };
  try {
    // Stop a watcher that may still be running in a different frame from an earlier source
    // selection, but keep the persisted binding until the new one successfully starts.
    await stopUniversalRollingWatchers({ forget: false });
    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: 'opensub-rolling-start-track',
      binding: {
        pageUrl: pageKey,
        videoIndex: trackInfo.videoIndex,
        trackIndex: trackInfo.trackIndex,
        label: trackInfo.label || '',
        language: trackInfo.language || '',
        kind: trackInfo.kind || '',
        sourceLanguage: sourceLanguage || 'auto',
        targetLanguage: targetLanguage || '',
        sourceFileName: sourceFileName || `${trackInfo.label || 'site-subtitles'}.srt`
      }
    }, { frameId: trackInfo.frameId });
    return result || { ok: false };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
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

  // EBU-TT-D (used by ARD/KiKA and other European broadcasters) is TTML with namespace
  // prefixes such as <tt:tt>, <tt:p>, <tt:span> and <tt:br>. Query by localName so both
  // prefixed and unprefixed TTML work identically.
  const root = doc.documentElement;
  const frameRate = Number(root?.getAttributeNS?.('http://www.w3.org/ns/ttml#parameter', 'frameRate') || root?.getAttribute?.('ttp:frameRate') || 30) || 30;
  const tickRate = Number(root?.getAttributeNS?.('http://www.w3.org/ns/ttml#parameter', 'tickRate') || root?.getAttribute?.('ttp:tickRate') || 0) || 0;

  function ttmlTime(value) {
    if (value === null || value === undefined || value === '') return null;
    const raw = String(value).trim();
    if (!raw) return null;
    let m = raw.match(/^(\d+):(\d{2}):(\d{2}):(\d{1,3})(?:\.(\d+))?$/);
    if (m) {
      const frames = Number(m[4]) + (m[5] ? Number(`0.${m[5]}`) : 0);
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frames / Math.max(1, frameRate);
    }
    m = raw.match(/^(-?\d+(?:\.\d+)?)f$/i);
    if (m) return Number(m[1]) / Math.max(1, frameRate);
    m = raw.match(/^(-?\d+(?:\.\d+)?)t$/i);
    if (m && tickRate > 0) return Number(m[1]) / tickRate;
    return parseFlexibleTime(raw);
  }

  function nodeText(node) {
    const parts = [];
    function walk(current) {
      for (const child of current?.childNodes || []) {
        if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
          parts.push(child.nodeValue || '');
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const local = String(child.localName || child.nodeName || '').toLowerCase().replace(/^.*:/, '');
          if (local === 'br') parts.push('\n');
          else walk(child);
        }
      }
    }
    walk(node);
    return cleanSubtitleText(parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n'));
  }

  const nodes = [...doc.getElementsByTagName('*')].filter(node => String(node.localName || '').toLowerCase() === 'p');
  const cues = [];
  for (const p of nodes) {
    const beginRaw = p.getAttribute('begin');
    const endRaw = p.getAttribute('end');
    const durRaw = p.getAttribute('dur');
    const start = ttmlTime(beginRaw);
    let end = ttmlTime(endRaw);
    const dur = ttmlTime(durRaw);
    if (end === null && start !== null && dur !== null) end = start + dur;
    if (start === null || end === null || end < start) continue;
    const text = nodeText(p);
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

  if (/<(?:[a-z0-9_.-]+:)?tt(?:\s|>)/i.test(text) || /ttml|dfxp|ebu-?tt|ebutt|application\/xml/i.test(`${meta.url || ''} ${meta.contentType || ''} ${meta.format || ''}`)) {
    cues = parseTtml(text);
    if (cues.length) {
      const isEbu = /ebu-?tt|ebutt|EBU-TT-D/i.test(`${text.slice(0, 1200)} ${meta.url || ''} ${meta.format || ''}`);
      return { cues, format: isEbu ? 'EBU-TT-D / TTML' : 'TTML/DFXP' };
    }
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

function distributeSentenceTranslation(groupCues, translatedText) {
  const cues = (groupCues || []).filter(cue => cue && Number.isFinite(Number(cue.start)) && Number.isFinite(Number(cue.end)));
  const text = String(translatedText || '').replace(/\s+/g, ' ').trim();
  if (!cues.length || !text) return [];
  if (cues.length === 1) return [{ start: cues[0].start, end: cues[0].end, text }];

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < cues.length) {
    return [{ start: cues[0].start, end: cues[cues.length - 1].end, text }];
  }

  const weights = cues.map(cue => Math.max(1, sentenceBoundaryText(cue.text).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let wordStart = 0;
  let cumulativeWeight = 0;
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    cumulativeWeight += weights[i];
    let wordEnd = i === cues.length - 1
      ? words.length
      : Math.round((cumulativeWeight / totalWeight) * words.length);
    const remainingCues = cues.length - i - 1;
    wordEnd = Math.max(wordStart + 1, Math.min(words.length - Math.min(remainingCues, words.length - 1), wordEnd));
    if (wordStart >= words.length) break;
    const part = words.slice(wordStart, wordEnd).join(' ').trim();
    if (part) out.push({ start: cues[i].start, end: cues[i].end, text: part });
    wordStart = wordEnd;
  }
  if (wordStart < words.length && out.length) out[out.length - 1].text += ` ${words.slice(wordStart).join(' ')}`;
  return out;
}

function getSiteKey(raw = currentTab?.url || '') {
  try {
    let host = new URL(raw).hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch (_) {
    return '';
  }
}

function timingObservationPageKey(raw = currentTab?.url || '') {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:t|start|time_continue|utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch (_) {
    return pageKey;
  }
}

function roundOffset(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function siteTimingProfile() {
  const key = getSiteKey();
  return key ? siteTimingProfiles[key] || null : null;
}

function learnedSiteOffset() {
  const value = Number(siteTimingProfile()?.learnedOffset);
  return Number.isFinite(value) ? value : null;
}

function recomputeSiteTimingProfile(profile) {
  const observations = Object.values(profile?.observations || {})
    .map(item => ({ offset: Number(item?.offset), updatedAt: item?.updatedAt || '' }))
    .filter(item => Number.isFinite(item.offset));
  if (observations.length < 2) {
    delete profile.learnedOffset;
    profile.sampleCount = 0;
    return profile;
  }

  let best = [];
  for (const candidate of observations) {
    const tolerance = Math.max(0.35, Math.min(1.5, 0.25 + Math.abs(candidate.offset) * 0.15));
    const cluster = observations.filter(item => Math.abs(item.offset - candidate.offset) <= tolerance);
    if (cluster.length > best.length) best = cluster;
    else if (cluster.length === best.length && cluster.length) {
      const spread = values => Math.max(...values.map(v => v.offset)) - Math.min(...values.map(v => v.offset));
      if (spread(cluster) < spread(best)) best = cluster;
    }
  }

  if (best.length < 2) {
    delete profile.learnedOffset;
    profile.sampleCount = 0;
    return profile;
  }
  const mean = best.reduce((sum, item) => sum + item.offset, 0) / best.length;
  const maxDeviation = Math.max(...best.map(item => Math.abs(item.offset - mean)));
  const allowed = Math.max(0.4, Math.min(1.5, 0.3 + Math.abs(mean) * 0.15));
  if (maxDeviation > allowed) {
    delete profile.learnedOffset;
    profile.sampleCount = 0;
    return profile;
  }
  profile.learnedOffset = roundOffset(mean);
  profile.sampleCount = best.length;
  return profile;
}

async function recordSiteTimingObservation(offset) {
  const siteKey = getSiteKey();
  if (!siteKey || selectedSourceMode === 'live') return;
  const profile = siteTimingProfiles[siteKey] || { observations: {} };
  profile.observations = profile.observations && typeof profile.observations === 'object' ? profile.observations : {};
  profile.observations[timingObservationPageKey()] = { offset: roundOffset(offset), updatedAt: new Date().toISOString() };

  const recent = Object.entries(profile.observations)
    .sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')))
    .slice(0, 20);
  profile.observations = Object.fromEntries(recent);
  profile.updatedAt = new Date().toISOString();
  recomputeSiteTimingProfile(profile);
  siteTimingProfiles[siteKey] = profile;
  await chrome.storage.local.set({ [SITE_TIMING_KEY]: siteTimingProfiles });
}

function renderSiteTimingState() {
  const state = document.getElementById('siteTimingState');
  const forget = document.getElementById('forgetSiteTiming');
  if (!state || !forget) return;
  const profile = siteTimingProfile();
  const learned = learnedSiteOffset();
  const observationCount = Object.keys(profile?.observations || {}).length;
  if (learned !== null && Number(profile?.sampleCount || 0) >= 2) {
    state.textContent = `Site timing: ${learned >= 0 ? '+' : ''}${learned.toFixed(2)}s learned from ${profile.sampleCount} similar corrections. Stored only in Chrome on this device.`;
    forget.disabled = false;
  } else if (observationCount) {
    state.textContent = `Site timing: learning from ${observationCount} correction${observationCount === 1 ? '' : 's'}; OpenSub needs at least two similar corrections before applying one automatically. Stored only in Chrome on this device.`;
    forget.disabled = false;
  } else {
    state.textContent = 'Site timing: no learned correction yet. Timing observations stay only in Chrome on this device.';
    forget.disabled = true;
  }
}

function summarizeSiteTimingForDebug() {
  const profile = siteTimingProfile();
  if (!profile) return null;
  return {
    site: getSiteKey(),
    learnedOffset: Number.isFinite(Number(profile.learnedOffset)) ? Number(profile.learnedOffset) : null,
    sampleCount: Number(profile.sampleCount || 0),
    observationCount: Object.keys(profile.observations || {}).length,
    updatedAt: profile.updatedAt || ''
  };
}

function cueSampleIndices(length, maxPerSection = 10) {
  if (!length) return [];
  const picks = new Set();
  const addRange = (start, end, count) => {
    if (end <= start) return;
    const n = Math.min(count, end - start);
    for (let i = 0; i < n; i++) {
      const index = Math.min(end - 1, start + Math.floor((i * (end - start)) / n));
      picks.add(index);
    }
  };
  addRange(0, Math.min(length, Math.max(12, Math.floor(length * 0.18))), maxPerSection);
  const middleStart = Math.max(0, Math.floor(length * 0.42));
  const middleEnd = Math.min(length, Math.ceil(length * 0.58));
  addRange(middleStart, middleEnd, maxPerSection);
  const lateStart = Math.max(0, Math.floor(length * 0.82));
  addRange(lateStart, length, maxPerSection);
  return [...picks].sort((a, b) => a - b);
}

function nearestCueStartDistance(cues, value) {
  let lo = 0, hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(cues[mid].start) < value) lo = mid + 1;
    else hi = mid;
  }
  let best = Infinity;
  for (let i = Math.max(0, lo - 2); i <= Math.min(cues.length - 1, lo + 2); i++) {
    best = Math.min(best, Math.abs(Number(cues[i].start) - value));
  }
  return best;
}

function overlapScoreForCue(source, translatedCue, shift) {
  const start = Number(translatedCue.start) + shift;
  const end = Number(translatedCue.end) + shift;
  const duration = Math.max(0.1, end - start);
  let bestOverlap = 0;
  let lo = 0, hi = source.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(source[mid].end) < start - 1) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 2); i < source.length && Number(source[i].start) <= end + 1; i++) {
    const sStart = Number(source[i].start);
    const sEnd = Number(source[i].end);
    const overlap = Math.max(0, Math.min(end, sEnd) - Math.max(start, sStart));
    const denom = Math.max(0.1, Math.min(duration, sEnd - sStart));
    bestOverlap = Math.max(bestOverlap, overlap / denom);
  }
  const startDistance = nearestCueStartDistance(source, start);
  const startScore = Math.max(0, 1 - startDistance / 1.1);
  return Math.max(Math.min(1, bestOverlap), startScore * 0.9);
}

function scoreAlignmentShift(source, translated, shift) {
  const indices = cueSampleIndices(translated.length, 10);
  if (!indices.length) return { score: 0, sectionMin: 0 };
  const sections = [[], [], []];
  let total = 0;
  indices.forEach(index => {
    const score = overlapScoreForCue(source, translated[index], shift);
    total += score;
    const fraction = translated.length <= 1 ? 0 : index / (translated.length - 1);
    const section = fraction < 0.34 ? 0 : (fraction < 0.67 ? 1 : 2);
    sections[section].push(score);
  });
  const sectionMeans = sections.filter(section => section.length).map(section => section.reduce((a, b) => a + b, 0) / section.length);
  return {
    score: total / indices.length,
    sectionMin: sectionMeans.length ? Math.min(...sectionMeans) : 0
  };
}

function analyzeSubtitleAlignment(sourceCuesInput, translatedCuesInput) {
  const source = (sourceCuesInput || []).filter(c => c?.text && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end))).sort((a, b) => a.start - b.start);
  const translated = (translatedCuesInput || []).filter(c => c?.text && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end))).sort((a, b) => a.start - b.start);
  if (source.length < 2 || translated.length < 2) return { status: 'mismatch', shift: 0, score: 0, message: 'Not enough timed cues to compare these subtitle files reliably.' };

  const earlySource = source.slice(0, Math.min(14, source.length));
  const earlyTranslated = translated.slice(0, Math.min(14, translated.length));
  const candidates = new Set([0]);
  for (const sourceCue of earlySource) for (const translatedCue of earlyTranslated) {
    const delta = Number(sourceCue.start) - Number(translatedCue.start);
    if (Math.abs(delta) <= 30) candidates.add(Math.round(delta * 20) / 20);
  }

  let best = { shift: 0, score: -1, sectionMin: -1 };
  const consider = shift => {
    const scored = scoreAlignmentShift(source, translated, shift);
    const combined = scored.score * 0.72 + scored.sectionMin * 0.28;
    const bestCombined = best.score * 0.72 + best.sectionMin * 0.28;
    if (combined > bestCombined) best = { shift, ...scored };
  };
  for (const shift of candidates) consider(shift);
  const coarse = best.shift;
  for (let step = -20; step <= 20; step++) consider(Math.round((coarse + step * 0.05) * 100) / 100);

  const sourceDuration = Number(source[source.length - 1].end) - Number(source[0].start);
  const translatedDuration = Number(translated[translated.length - 1].end) - Number(translated[0].start);
  const durationRatio = sourceDuration > 1 && translatedDuration > 1 ? translatedDuration / sourceDuration : 1;
  const timelinePlausible = durationRatio > 0.78 && durationRatio < 1.28;
  const strong = best.score >= 0.62 && best.sectionMin >= 0.38 && timelinePlausible;
  const fair = best.score >= 0.50 && best.sectionMin >= 0.25 && timelinePlausible;
  const shift = Math.abs(best.shift) < 0.35 ? 0 : roundOffset(best.shift);

  if (strong) {
    if (!shift) return { status: 'matched', shift: 0, score: best.score, message: `✓ Subtitle timing looks aligned (${Math.round(best.score * 100)}% timing confidence).` };
    const direction = shift < 0 ? 'earlier' : 'later';
    return { status: 'offset', shift, score: best.score, message: `✓ The files appear synchronized with a consistent ${Math.abs(shift).toFixed(2)}s offset. OpenSub will shift the translated file ${Math.abs(shift).toFixed(2)}s ${direction}.` };
  }
  if (fair) {
    return { status: 'warning', shift: 0, score: best.score, message: `⚠ The files may describe the same video, but their cue timing/segmentation is inconsistent (${Math.round(best.score * 100)}% timing confidence). Review them or choose “Use anyway.”` };
  }
  return { status: 'mismatch', shift: 0, score: best.score, message: `⚠ These subtitle files do not appear reliably synchronized to the same timeline (${Math.round(best.score * 100)}% timing confidence). Choose “Use anyway” only if you know they belong together.` };
}

function shiftSubtitleCues(cues, shift) {
  const delta = Number(shift || 0);
  return (cues || []).map(cue => ({
    start: Math.max(0, Number(cue.start) + delta),
    end: Math.max(0.01, Number(cue.end) + delta),
    text: cue.text
  })).filter(cue => cue.end > cue.start);
}

function clearProvidedTranslation() {
  providedTranslationCues = [];
  providedTranslationText = '';
  providedTranslationFileName = '';
  providedTranslationAlignment = null;
  const input = document.getElementById('translatedSubtitleFile');
  if (input) input.value = '';
  const useAnyway = document.getElementById('pairUseAnyway');
  if (useAnyway) useAnyway.checked = false;
}

function updateProvidedTranslationAlignment() {
  const state = document.getElementById('pairSyncState');
  const useAnywayRow = document.getElementById('pairUseAnywayRow');
  const useAnyway = document.getElementById('pairUseAnyway');
  const action = document.getElementById('useProvidedTranslation');
  if (!state || !useAnywayRow || !useAnyway || !action) return;
  state.classList.remove('syncgood', 'syncwarn');
  useAnywayRow.classList.add('hidden');

  if (!providedTranslationCues.length) {
    providedTranslationAlignment = null;
    state.textContent = 'Choose a translated subtitle file to check timing.';
    action.disabled = true;
    return;
  }
  if (!sourceCues.length) {
    providedTranslationAlignment = null;
    state.textContent = `✓ Loaded ${providedTranslationFileName} • ${providedTranslationCues.length} cues. Now choose the website/original subtitle source.`;
    state.classList.add('syncwarn');
    action.disabled = true;
    return;
  }

  providedTranslationAlignment = analyzeSubtitleAlignment(sourceCues, providedTranslationCues);
  state.textContent = `${providedTranslationAlignment.message} Source: ${sourceCues.length} cues • Translation: ${providedTranslationCues.length} cues.`;
  const warning = providedTranslationAlignment.status === 'warning' || providedTranslationAlignment.status === 'mismatch';
  state.classList.add(warning ? 'syncwarn' : 'syncgood');
  useAnywayRow.classList.toggle('hidden', !warning);
  action.disabled = warning && !useAnyway.checked;
}

function setTranslationMethod(method) {
  translationMethod = method === 'provided' ? 'provided' : 'chrome';
  document.getElementById('translationMethod').value = translationMethod;
  document.getElementById('providedTranslationPanel').classList.toggle('hidden', translationMethod !== 'provided');
  document.getElementById('translateSave').classList.toggle('hidden', translationMethod !== 'chrome');
  document.getElementById('useProvidedTranslation').classList.toggle('hidden', translationMethod !== 'provided');
  updateProvidedTranslationAlignment();
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
  for (const id of ['translateSave', 'saveOriginal', 'refreshDetection']) {
    const el = document.getElementById(id);
    if (el) el.disabled = value;
  }
  const providedAction = document.getElementById('useProvidedTranslation');
  if (providedAction) {
    if (value) providedAction.disabled = true;
    else updateProvidedTranslationAlignment();
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
    renderSiteTimingState();
    return;
  }
  card.classList.remove('hidden');
  document.getElementById('entryEnabled').checked = entry.enabled !== false;
  document.getElementById('offsetValue').textContent = `${Number(entry.offset || 0) >= 0 ? '+' : ''}${Number(entry.offset || 0).toFixed(2)}s`;
  const language = entry.translatedText ? `${entry.sourceLanguage || '?'} → ${entry.targetLanguage || '?'}` : `${entry.sourceLanguage || 'original'}`;
  const methodNote = entry.translationMethod === 'provided' ? ' • supplied translation' : '';
  document.getElementById('savedState').textContent = `Saved track: ${entry.cueCount || '?'} cues • ${language}${methodNote}`;
  document.getElementById('downloadTranslation').disabled = !entry.translatedText;
  document.getElementById('downloadSource').disabled = !entry.sourceText;
  renderSiteTimingState();
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

  detectedNetwork.sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));

  const subtitleSelect = document.getElementById('detectedSubtitle');
  const previousSelection = subtitleSelect.value;
  subtitleSelect.innerHTML = '';

  const totalDetected = detectedTracks.length + detectedNetwork.length;
  const placeholder = new Option(
    totalDetected ? `Choose from ${totalDetected} detected subtitle source${totalDetected === 1 ? '' : 's'}…` : 'No downloadable subtitle tracks detected',
    ''
  );
  subtitleSelect.add(placeholder);

  if (detectedTracks.length) {
    const group = document.createElement('optgroup');
    group.label = 'HTML5 / player tracks';
    detectedTracks.forEach((track, i) => {
      const label = `${track.label || 'Subtitle'}${track.language ? ` [${track.language}]` : ''}${track.mode === 'showing' ? ' • active' : ''}${track.cueCount !== null ? ` • ${track.cueCount} cues` : ''}`;
      group.appendChild(new Option(label, `html5:${i}`));
    });
    subtitleSelect.appendChild(group);
  }

  if (detectedNetwork.length) {
    const group = document.createElement('optgroup');
    group.label = 'Captured timed-text / subtitle files';
    detectedNetwork.forEach((resource, i) => {
      const kb = Math.max(1, Math.round(Number(resource.size || 0) / 1024));
      group.appendChild(new Option(`${resource.format || 'Timed text'} • ${kb} KB • ${shortResourceName(resource.url)}`, `network:${i}`));
    });
    subtitleSelect.appendChild(group);
  }

  if (previousSelection && [...subtitleSelect.options].some(option => option.value === previousSelection)) {
    subtitleSelect.value = previousSelection;
  } else {
    // Deliberately leave the placeholder selected. Merely detecting a track must never
    // toggle/capture it; capture starts only when the user explicitly selects a source.
    subtitleSelect.value = '';
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
  if (!result?.cues?.length) throw new Error('The HTML5 track exists, but its cue list is inaccessible. Try another detected subtitle source or Live translation.');
  sourceCues = result.cues.map(c => ({ start: Number(c.start), end: Number(c.end), text: cleanSubtitleText(c.text) })).filter(c => c.text);
  sourceText = cuesToSrt(sourceCues);
  sourceFileName = `${result.label || 'site-subtitles'}.srt`;
  if (result.language && LANGUAGES.some(([code]) => code === result.language) && document.getElementById('sourceLanguage').value === 'auto') document.getElementById('sourceLanguage').value = result.language;
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

function sentenceBoundaryText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isStandaloneNonSpeechCue(text) {
  const value = sentenceBoundaryText(text);
  if (!value) return true;
  // Music/sound/action captions are already complete semantic units even without a period.
  return /^(?:\[[^\]]+\]|\([^\)]+\)|♪[^♪]*♪|♫[^♫]*♫)$/u.test(value);
}

function startsNewSpeakerTurn(text) {
  const value = sentenceBoundaryText(text);
  return /^(?:[-–—]\s+|[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ0-9 .'-]{1,28}:\s+)/u.test(value);
}

function endsSentence(text) {
  const value = sentenceBoundaryText(text);
  if (!value) return false;
  if (isStandaloneNonSpeechCue(value)) return true;

  // Do not split on a few very common abbreviations even though they end in a period.
  const stripped = value.replace(/["'”’»）)\]}]+$/u, '').trim();
  if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.$/i.test(stripped)) return false;
  if (/\b[A-Z]\.$/.test(stripped)) return false;

  return /[.!?…。！？]["'”’»）)\]}]*$/u.test(value);
}

function joinSentenceFragments(cues) {
  let out = '';
  for (const cue of cues) {
    const part = sentenceBoundaryText(cue.text);
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }

    // Subtitle files sometimes split a word with a trailing hyphen. Rejoin only when the next
    // fragment begins lower-case; dialogue dashes remain untouched.
    if (/-$/u.test(out) && /^[\p{Ll}]/u.test(part)) out = `${out.slice(0, -1)}${part}`;
    else out += ` ${part}`;
  }
  return out.replace(/\s+([,.;:!?…])/gu, '$1').trim();
}

function buildSentenceTranslationGroups(cues) {
  const groups = [];
  let group = [];
  let chars = 0;

  const flush = () => {
    if (!group.length) return;
    groups.push({
      cues: group,
      start: group[0].start,
      end: group[group.length - 1].end,
      text: joinSentenceFragments(group)
    });
    group = [];
    chars = 0;
  };

  for (const cue of cues) {
    const text = sentenceBoundaryText(cue.text);
    if (!text) continue;

    const previous = group[group.length - 1];
    const gap = previous ? Number(cue.start) - Number(previous.end) : 0;
    const spanIfAdded = group.length ? Number(cue.end) - Number(group[0].start) : 0;

    // These limits keep malformed/no-punctuation subtitle files from becoming giant paragraphs.
    // A clear speaker change is also a safe semantic boundary when punctuation is missing.
    if (group.length && (
      gap > 1.75 ||
      gap < -8 ||
      chars + text.length > 420 ||
      group.length >= 10 ||
      spanIfAdded > 18 ||
      startsNewSpeakerTurn(text)
    )) flush();

    group.push(cue);
    chars += text.length + 1;

    if (endsSentence(text)) flush();
  }
  flush();
  return groups.filter(group => group.text);
}

async function translateCompleteFileCues(cues, sourceLanguage, targetLanguage) {
  // Sentence-aware translation is intentionally *not* used for HTML5/live/rolling sources.
  // It is only called for uploaded or captured/downloaded complete subtitle resources.
  const groups = buildSentenceTranslationGroups(cues);
  if (!groups.length) return [];

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
  try {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const translated = String(await translator.translate(group.text) || '').trim() || group.text;
      out.push(...distributeSentenceTranslation(group.cues, translated));
      if (i % 2 === 0 || i === groups.length - 1) {
        progress(
          20 + ((i + 1) / groups.length) * 78,
          `Translating sentence ${i + 1} of ${groups.length}…`
        );
      }
    }
  } finally {
    translator.destroy?.();
  }
  return out;
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

async function createEntry({ translatedCues = null, sourceLanguage = '', targetLanguage = '', translationMetadata = null }) {
  const title = cleanTitle(currentTab?.title || 'Video page');
  const entry = library[pageKey] || {};
  const hasExistingOffset = Object.prototype.hasOwnProperty.call(entry, 'offset');
  const learned = learnedSiteOffset();
  const startingOffset = hasExistingOffset ? Number(entry.offset || 0) : (learned ?? 0);
  library[pageKey] = {
    ...entry,
    pageUrl: pageKey,
    title,
    enabled: true,
    offset: roundOffset(startingOffset),
    fontScale: Number(entry.fontScale || 0.045),
    sourceLanguage: sourceLanguage || entry.sourceLanguage || '',
    targetLanguage: translatedCues ? targetLanguage : '',
    sourceFileName: sourceFileName || entry.sourceFileName || 'subtitles.srt',
    sourceText: sourceText || cuesToSrt(sourceCues),
    translatedText: translatedCues ? cuesToSrt(translatedCues) : '',
    cueCount: sourceCues.length,
    translationMethod: translatedCues ? (translationMetadata?.method || 'chrome') : '',
    translatedFileName: translatedCues ? (translationMetadata?.translatedFileName || '') : '',
    pairAlignment: translatedCues && translationMetadata?.pairAlignment ? translationMetadata.pairAlignment : null,
    siteTimingApplied: !hasExistingOffset && learned !== null,
    updatedAt: new Date().toISOString()
  };
  await saveLibrary();
  await notifyTab();
  renderSavedEntry();
  return { appliedSiteOffset: !hasExistingOffset && learned !== null ? learned : null };
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

async function resetCaptionDiscoverySession() {
  if (!currentTab?.id) return;
  try {
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      func: () => location.href
    });
    const frameIds = [...new Set(frameResults.map(result => result.frameId).filter(Number.isInteger))];
    await Promise.all(frameIds.map(frameId =>
      chrome.tabs.sendMessage(
        currentTab.id,
        { type: 'opensub-reset-caption-session' },
        { frameId }
      ).catch(() => null)
    ));
    // Give the MAIN-world probe a moment to replay only the subtitle responses captured in
    // this current page session before the dropdown is rebuilt.
    await new Promise(resolve => setTimeout(resolve, 180));
  } catch (_) {}
}

function summarizeSavedEntry(entry) {
  if (!entry) return null;
  const previewCues = text => {
    try { return parseUniversalSubtitle(text || '', { url: 'debug.srt' }).cues.slice(0, 12); } catch (_) { return []; }
  };
  return {
    title: entry.title || '',
    pageUrl: entry.pageUrl || entry.url || '',
    enabled: entry.enabled !== false,
    sourceLanguage: entry.sourceLanguage || '',
    targetLanguage: entry.targetLanguage || '',
    sourceFileName: entry.sourceFileName || '',
    cueCount: entry.cueCount ?? null,
    offset: Number(entry.offset || 0),
    updatedAt: entry.updatedAt || '',
    dynamicSource: entry.dynamicSource || '',
    translationMethod: entry.translationMethod || '',
    translatedFileName: entry.translatedFileName || '',
    pairAlignment: entry.pairAlignment || null,
    siteTimingApplied: Boolean(entry.siteTimingApplied),
    sourcePreview: previewCues(entry.sourceText),
    translatedPreview: previewCues(entry.translatedText)
  };
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(fileName);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function buildDebugDump() {
  const frames = await inspectFrames();
  const detailedFrames = [];
  for (const frame of frames) {
    let runtimeDebug = null;
    try {
      runtimeDebug = await chrome.tabs.sendMessage(currentTab.id, { type: 'opensub-debug-dump' }, { frameId: frame.frameId });
    } catch (error) {
      runtimeDebug = { ok: false, error: error?.message || String(error) };
    }
    detailedFrames.push({
      frameId: frame.frameId,
      frameUrl: frame.result?.frameUrl || frame.extra?.frameUrl || '',
      inspectedVideos: frame.result?.videos || [],
      normalOpenSubInspection: frame.extra || null,
      runtimeDebug
    });
  }

  let plutoBindings = {};
  let rollingBindings = {};
  try {
    const data = await chrome.storage.local.get(['openSubPlutoBindings', 'openSubRollingBindings']);
    plutoBindings = data.openSubPlutoBindings || {};
    rollingBindings = data.openSubRollingBindings || {};
  } catch (_) {}

  // Query the universal rolling watcher separately so reports from live/rotating TextTrack
  // sites show whether the source was reacquired or its timeline/window was replaced.
  // The source-echo guard is source-agnostic, so include its status too; this lets reports
  // distinguish a TextTrack issue from a site DOM renderer that is duplicating the source.
  for (const frame of detailedFrames) {
    try {
      frame.rollingTrackStatus = await chrome.tabs.sendMessage(currentTab.id, { type: 'opensub-rolling-status' }, { frameId: frame.frameId });
    } catch (_) {
      frame.rollingTrackStatus = null;
    }
    try {
      frame.captionGuardStatus = await chrome.tabs.sendMessage(currentTab.id, { type: 'opensub-caption-guard-status' }, { frameId: frame.frameId });
    } catch (_) {
      frame.captionGuardStatus = null;
    }
    try {
      frame.subtitleDiscoveryStatus = await chrome.tabs.sendMessage(currentTab.id, { type: 'opensub-subtitle-discovery-status' }, { frameId: frame.frameId });
    } catch (_) {
      frame.subtitleDiscoveryStatus = null;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    extension: {
      name: chrome.runtime.getManifest().name,
      version: chrome.runtime.getManifest().version,
      versionName: chrome.runtime.getManifest().version_name || ''
    },
    tab: {
      id: currentTab?.id ?? null,
      title: currentTab?.title || '',
      url: currentTab?.url || '',
      normalizedPageKey: pageKey
    },
    popupState: {
      selectedSourceMode,
      selectedDetectedSubtitle: document.getElementById('detectedSubtitle')?.value || '',
      loadedDetectedSelection,
      sourceFileName,
      loadedSourceCueCount: sourceCues.length,
      sourceInputKind,
      translationMethod,
      providedTranslationFileName,
      providedTranslationCueCount: providedTranslationCues.length,
      providedTranslationAlignment,
      sourceLanguage: document.getElementById('sourceLanguage')?.value || '',
      targetLanguage: document.getElementById('targetLanguage')?.value || '',
      liveActive,
      bestFrameId,
      detectedTrackCount: detectedTracks.length,
      detectedNetworkCount: detectedNetwork.length
    },
    globalSettings: { ...globalSettings },
    siteTimingForThisSite: summarizeSiteTimingForDebug(),
    savedEntryForThisPage: summarizeSavedEntry(library[pageKey]),
    plutoBindingForThisPage: plutoBindings[pageKey] || null,
    rollingBindingForThisPage: rollingBindings[pageKey] || null,
    detectedTracks,
    detectedNetwork: detectedNetwork.map(item => ({ ...item })),
    frames: detailedFrames
  };
}

async function refreshDetection() {
  setMessage('Refreshing player and caption detection…');
  const recovered = await ensureOpenSubRuntime();
  if (recovered) {
    // The first reset in init may have run before a stale frame was healed. Re-arm discovery
    // now that the receiver exists, then give current-session network payloads time to replay.
    await resetCaptionDiscoverySession();
  }
  const frames = await inspectFrames();
  renderDetectedFrames(frames);
  if (recovered) {
    setMessage(`✓ OpenSub automatically restored its runtime in ${recovered} stale video frame${recovered === 1 ? '' : 's'}. No page reload was required.`);
  } else {
    setMessage('Detection refreshed.');
  }
}

async function init() {
  populateLanguages();
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageKey = normalizeUrl(currentTab?.url || '');
  document.getElementById('pageTitle').textContent = cleanTitle(currentTab?.title || 'Current page');
  document.getElementById('pageUrl').textContent = pageKey;
  const data = await safeStorageGet([LIBRARY_KEY, GLOBAL_KEY, SITE_TIMING_KEY]);
  library = data[LIBRARY_KEY] || {};
  siteTimingProfiles = data[SITE_TIMING_KEY] || {};
  globalSettings = { enabled: true, subtitleSize: 'medium', hideOriginalCaptions: false, sourceMode: 'html5', sourceLanguage: 'auto', targetLanguage: 'en', ...(data[GLOBAL_KEY] || {}) };
  document.getElementById('globalEnabled').checked = globalSettings.enabled !== false;
  document.getElementById('subtitleSize').value = globalSettings.subtitleSize || 'medium';
  document.getElementById('hideOriginalCaptions').checked = Boolean(globalSettings.hideOriginalCaptions);
  document.getElementById('sourceLanguage').value = LANGUAGES.some(([code]) => code === globalSettings.sourceLanguage) ? globalSettings.sourceLanguage : 'auto';
  document.getElementById('targetLanguage').value = LANGUAGES.some(([code]) => code === globalSettings.targetLanguage && code !== 'auto') ? globalSettings.targetLanguage : 'en';
  setSourceMode(globalSettings.sourceMode || 'html5');
  setTranslationMethod('chrome');
  renderSavedEntry();

  // Opening OpenSub starts a fresh transient caption-discovery session. Saved subtitles and
  // preferences stay intact; only stale network candidates / DOM trust are re-armed.
  await resetCaptionDiscoverySession();
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
    loadedDetectedSelection = '';
    document.getElementById('detectedSubtitle').value = '';
    sourceInputKind = 'file';
    sourceCues = parsed.cues;
    sourceText = cuesToSrt(parsed.cues);
    sourceFileName = file.name;
    document.getElementById('sourceState').textContent = `✓ Loaded ${file.name} • ${parsed.cues.length} cues • ${parsed.format}`;
    updateProvidedTranslationAlignment();
    setMessage('');
  } catch (error) {
    setMessage(error.message, true);
  }
});

async function loadDetectedSelection(selection) {
  if (!selection) {
    sourceCues = [];
    sourceText = '';
    sourceFileName = '';
    sourceInputKind = 'none';
    loadedDetectedSelection = '';
    document.getElementById('sourceState').textContent = 'Choose a detected subtitle source above, or upload a file.';
    updateProvidedTranslationAlignment();
    return;
  }

  const serial = ++selectionLoadSerial;
  const [kind, indexText] = selection.split(':');
  const index = Number(indexText);
  setBusy(true);

  try {
    if (kind === 'html5') {
      setMessage('Loading the selected HTML5 subtitle track…');
      await captureTrack(index);
      if (serial !== selectionLoadSerial) return;
      sourceInputKind = 'html5';
      loadedDetectedSelection = selection;
      document.getElementById('sourceState').textContent = `✓ Loaded ${sourceFileName} • ${sourceCues.length} cues • HTML5 track`;
      updateProvidedTranslationAlignment();
      setMessage('Subtitle track loaded. Translate it or overlay it as-is.');
    } else if (kind === 'network') {
      setMessage('Loading the selected timed-text subtitle resource…');
      await captureNetworkResource(index);
      if (serial !== selectionLoadSerial) return;
      sourceInputKind = 'network';
      loadedDetectedSelection = selection;
      document.getElementById('sourceState').textContent = `✓ Loaded captured subtitles • ${sourceCues.length} cues`;
      updateProvidedTranslationAlignment();
      setMessage('Subtitle resource loaded. Translate it or overlay it as-is.');
    } else {
      throw new Error('That subtitle source is no longer available. Refresh detection and try again.');
    }
  } catch (error) {
    if (serial === selectionLoadSerial) {
      loadedDetectedSelection = '';
      setMessage(error.message, true);
    }
  } finally {
    if (serial === selectionLoadSerial) setBusy(false);
  }
}

document.getElementById('detectedSubtitle').addEventListener('change', async e => {
  await loadDetectedSelection(e.target.value);
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
    const sentenceAware = sourceInputKind === 'file' || sourceInputKind === 'network';
    const translated = sentenceAware
      ? await translateCompleteFileCues(sourceCues, sourceLanguage, targetLanguage)
      : await translateCues(sourceCues, sourceLanguage, targetLanguage);
    const created = await createEntry({ translatedCues: translated, sourceLanguage, targetLanguage, translationMetadata: { method: 'chrome' } });
    const plutoWatcher = await startPlutoDynamicWatcher(sourceLanguage, targetLanguage);
    const rollingWatcher = await startUniversalRollingWatcher(sourceLanguage, targetLanguage);
    progress(100, sentenceAware
      ? `Done — sentence-aware translation saved across ${translated.length} timed cues from ${sourceCues.length} source cues.`
      : `Done — ${translated.length} cues translated and saved.`);
    if (plutoWatcher?.ok) setMessage(`✓ Saved ${sourceLanguage} → ${targetLanguage} subtitles. Rolling Pluto/Shaka tracking is active.`);
    else if (rollingWatcher?.ok) setMessage(`✓ Saved ${sourceLanguage} → ${targetLanguage} subtitles. Rolling/replaced TextTrack monitoring is active.`);
    else setMessage(`✓ Saved ${sourceLanguage} → ${targetLanguage} subtitles for this page.${created?.appliedSiteOffset !== null && created?.appliedSiteOffset !== undefined ? ` Applied learned site timing ${created.appliedSiteOffset >= 0 ? '+' : ''}${Number(created.appliedSiteOffset).toFixed(2)}s.` : ''}`);
  } catch (error) {
    setMessage(`Translation failed: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
});

document.getElementById('translationMethod').addEventListener('change', e => {
  setTranslationMethod(e.target.value);
});

document.getElementById('translatedSubtitleFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) {
    clearProvidedTranslation();
    updateProvidedTranslationAlignment();
    return;
  }
  try {
    const text = await file.text();
    const parsed = parseUniversalSubtitle(text, { url: file.name });
    providedTranslationCues = parsed.cues;
    providedTranslationText = cuesToSrt(parsed.cues);
    providedTranslationFileName = file.name;
    document.getElementById('pairUseAnyway').checked = false;
    updateProvidedTranslationAlignment();
    setMessage(`Loaded translated file ${file.name}. OpenSub checked its timing against the current original source.`);
  } catch (error) {
    clearProvidedTranslation();
    updateProvidedTranslationAlignment();
    setMessage(`Could not load translated subtitle file: ${error.message}`, true);
  }
});

document.getElementById('pairUseAnyway').addEventListener('change', updateProvidedTranslationAlignment);

document.getElementById('useProvidedTranslation').addEventListener('click', async () => {
  if (!sourceCues.length) return setMessage('Choose the website/original subtitle source first.', true);
  if (!providedTranslationCues.length) return setMessage('Choose a translated subtitle file first.', true);
  updateProvidedTranslationAlignment();
  const alignment = providedTranslationAlignment;
  const warning = alignment?.status === 'warning' || alignment?.status === 'mismatch';
  if (warning && !document.getElementById('pairUseAnyway').checked) return setMessage('OpenSub found a timing mismatch. Check “Use this translated file anyway” if you want to continue.', true);

  setBusy(true);
  try {
    await stopUniversalRollingWatchers({ forget: true });
    if (isPlutoPage()) {
      const frameIds = await rollingFrameIds();
      await Promise.all(frameIds.map(frameId => chrome.tabs.sendMessage(
        currentTab.id,
        { type: 'opensub-pluto-stop-track', forget: true },
        { frameId }
      ).catch(() => null)));
    }

    const pairShift = alignment?.status === 'offset' ? Number(alignment.shift || 0) : 0;
    const alignedTranslated = shiftSubtitleCues(providedTranslationCues, pairShift);
    let sourceLanguage = document.getElementById('sourceLanguage').value;
    if (sourceLanguage === 'auto') sourceLanguage = '';
    const targetLanguage = document.getElementById('targetLanguage').value;
    const created = await createEntry({
      translatedCues: alignedTranslated,
      sourceLanguage,
      targetLanguage,
      translationMetadata: {
        method: 'provided',
        translatedFileName: providedTranslationFileName,
        pairAlignment: {
          status: alignment?.status || 'unknown',
          appliedShift: pairShift,
          confidence: Number(alignment?.score || 0)
        }
      }
    });
    const shiftNote = pairShift ? ` Translated-file alignment: ${pairShift >= 0 ? '+' : ''}${pairShift.toFixed(2)}s.` : '';
    const siteNote = created?.appliedSiteOffset !== null && created?.appliedSiteOffset !== undefined
      ? ` Applied learned site timing ${created.appliedSiteOffset >= 0 ? '+' : ''}${Number(created.appliedSiteOffset).toFixed(2)}s.`
      : '';
    setMessage(`✓ Saved your translated subtitle file with the original track.${shiftNote}${siteNote}`);
  } catch (error) {
    setMessage(`Could not save the translated subtitle pair: ${error.message}`, true);
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
    const rollingWatcher = await startUniversalRollingWatcher(lang || 'auto', '');
    setMessage(rollingWatcher?.ok
      ? `✓ Saved ${sourceCues.length} original subtitle cues. Rolling/replaced TextTrack monitoring is active.`
      : `✓ Saved ${sourceCues.length} original subtitle cues for this page.`);
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

document.getElementById('downloadDebugDump').addEventListener('click', async () => {
  try {
    setMessage('Collecting subtitle diagnostics…');
    const dump = await buildDebugDump();
    const host = (() => { try { return new URL(currentTab?.url || '').hostname.replace(/[^a-z0-9.-]+/gi, '_') || 'page'; } catch (_) { return 'page'; } })();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJson(dump, `OpenSub-debug-${host}-${stamp}.json`);
    setMessage('✓ Debug dump downloaded. It is read-only and did not change subtitle state.');
  } catch (error) {
    setMessage(`Could not create debug dump: ${error.message}`, true);
  }
});




document.getElementById('sourceLanguage').addEventListener('change', async e => {
  globalSettings.sourceLanguage = e.target.value || 'auto';
  await chrome.storage.local.set({ [GLOBAL_KEY]: globalSettings });
});

document.getElementById('targetLanguage').addEventListener('change', async e => {
  globalSettings.targetLanguage = e.target.value || 'en';
  await chrome.storage.local.set({ [GLOBAL_KEY]: globalSettings });
});

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
    ? 'Translation-only mode enabled.'
    : 'Dual-caption mode enabled: OpenSub will show translation + original in one managed stack.');
});

document.getElementById('entryEnabled').addEventListener('change', async e => {
  if (!library[pageKey]) return;
  library[pageKey].enabled = e.target.checked;
  await saveLibrary();
  await notifyTab();
});

async function setOffsetValue(value, { recordSite = false } = {}) {
  if (!library[pageKey]) return;
  library[pageKey].offset = roundOffset(value);
  library[pageKey].siteTimingApplied = false;
  await saveLibrary();
  if (recordSite) await recordSiteTimingObservation(library[pageKey].offset);
  await notifyTab();
  renderSavedEntry();
}

async function adjustOffset(delta) {
  if (!library[pageKey]) return;
  await setOffsetValue(Number(library[pageKey].offset || 0) + Number(delta || 0), { recordSite: true });
}

document.querySelectorAll('[data-offset-delta]').forEach(button => {
  button.addEventListener('click', () => adjustOffset(Number(button.dataset.offsetDelta || 0)));
});

document.getElementById('resetOffset').addEventListener('click', () => setOffsetValue(0, { recordSite: true }));

document.getElementById('forgetSiteTiming').addEventListener('click', async () => {
  const siteKey = getSiteKey();
  if (!siteKey || !siteTimingProfiles[siteKey]) return;
  delete siteTimingProfiles[siteKey];
  await chrome.storage.local.set({ [SITE_TIMING_KEY]: siteTimingProfiles });
  renderSiteTimingState();
  setMessage('Forgot the learned timing for this site. The current video offset was left unchanged.');
});

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
  await stopUniversalRollingWatchers({ forget: true });
  delete library[pageKey];
  await saveLibrary();
  await notifyTab();
  renderSavedEntry();
  setMessage('Removed the saved subtitles for this page.');
});

document.getElementById('openLibrary').addEventListener('click', () => chrome.runtime.openOptionsPage());

init().catch(error => setMessage(`Initialization error: ${error.message}`, true));

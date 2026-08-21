'use strict';

let creatingOffscreen = null;
const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'Run Chrome document-only language detection/translation for live webpage captions.'
  }).finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  if (message.target === 'opensub-offscreen') return;

  if (message.type === 'opensub-context') {
    sendResponse({
      tabUrl: sender.tab?.url || '',
      tabTitle: sender.tab?.title || '',
      frameUrl: sender.url || '',
      frameId: sender.frameId ?? 0
    });
    return;
  }

  if (message.type === 'opensub-fetch-resource') {
    (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);
      try {
        const url = String(message.url || '');
        if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) resources can be inspected.');
        const maxBytes = Math.max(65536, Math.min(4 * 1024 * 1024, Number(message.maxBytes || 3 * 1024 * 1024)));
        const response = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal,
          referrer: /^https?:\/\//i.test(String(message.pageUrl || '')) ? String(message.pageUrl) : undefined
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const length = Number(response.headers.get('content-length') || 0);
        if (length && length > maxBytes) throw new Error('Resource is too large to inspect safely.');
        const text = await response.text();
        if (text.length > maxBytes) throw new Error('Resource is too large to inspect safely.');
        sendResponse({
          ok: true,
          url: response.url || url,
          contentType: response.headers.get('content-type') || '',
          text
        });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return true;
  }

  if (message.type === 'opensub-live-translate') {
    (async () => {
      try {
        await ensureOffscreen();
        const sessionKey = `${sender.tab?.id ?? 'tab'}:${sender.frameId ?? 0}`;
        const result = await chrome.runtime.sendMessage({
          target: 'opensub-offscreen',
          type: 'opensub-offscreen-translate',
          sessionKey,
          text: message.text,
          sourceLanguage: message.sourceLanguage || 'auto',
          targetLanguage: message.targetLanguage || 'en'
        });
        sendResponse(result || { ok: false, error: 'No response from live translator.' });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === 'opensub-reset-live-language') {
    (async () => {
      try {
        await ensureOffscreen();
        const sessionKey = `${sender.tab?.id ?? 'tab'}:${sender.frameId ?? 0}`;
        const result = await chrome.runtime.sendMessage({
          target: 'opensub-offscreen',
          type: 'opensub-offscreen-reset-session',
          sessionKey
        });
        sendResponse(result || { ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }
});

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

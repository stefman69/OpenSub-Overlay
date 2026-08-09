'use strict';

const translators = new Map();
const detectedLanguages = new Map();
let detectorPromise = null;

async function getDetector() {
  if (!('LanguageDetector' in self)) throw new Error('Chrome Language Detector API is unavailable.');
  if (!detectorPromise) detectorPromise = LanguageDetector.create();
  return detectorPromise;
}

async function detectLanguage(text, sessionKey) {
  if (detectedLanguages.has(sessionKey)) return detectedLanguages.get(sessionKey);
  const detector = await getDetector();
  const results = await detector.detect(String(text || '').slice(0, 4000));
  const language = results?.[0]?.detectedLanguage;
  if (!language) throw new Error('Could not detect the live caption language.');
  detectedLanguages.set(sessionKey, language);
  return language;
}

async function getTranslator(sourceLanguage, targetLanguage) {
  const key = `${sourceLanguage}->${targetLanguage}`;
  if (translators.has(key)) return translators.get(key);
  if (!('Translator' in self)) throw new Error('Chrome Translator API is unavailable in the background translation document.');
  const availability = await Translator.availability({ sourceLanguage, targetLanguage });
  if (availability === 'unavailable') throw new Error(`Chrome does not support ${sourceLanguage} → ${targetLanguage} on this computer.`);
  const translator = await Translator.create({ sourceLanguage, targetLanguage });
  translators.set(key, translator);
  return translator;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'opensub-offscreen') return;

  if (message.type === 'opensub-offscreen-translate') {
    (async () => {
      try {
        const text = String(message.text || '').trim();
        if (!text) return sendResponse({ ok: true, text: '', sourceLanguage: message.sourceLanguage || '' });
        const sessionKey = String(message.sessionKey || 'default');
        let sourceLanguage = String(message.sourceLanguage || 'auto');
        const targetLanguage = String(message.targetLanguage || 'en');
        if (sourceLanguage === 'auto') sourceLanguage = await detectLanguage(text, sessionKey);
        if (sourceLanguage === targetLanguage) return sendResponse({ ok: true, text, sourceLanguage });
        const translator = await getTranslator(sourceLanguage, targetLanguage);
        const translated = await translator.translate(text);
        sendResponse({ ok: true, text: String(translated || '').trim() || text, sourceLanguage });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === 'opensub-offscreen-reset-session') {
    detectedLanguages.delete(String(message.sessionKey || 'default'));
    sendResponse({ ok: true });
  }
});

(() => {
  'use strict';
  if (window.__openSubNetworkProbeInstalled) return;
  window.__openSubNetworkProbeInstalled = true;

  const MAX_TEXT = 3 * 1024 * 1024;
  const URL_HINT = /(?:caption|captions|subtitle|subtitles|timedtext|texttrack|webvtt|ttml|dfxp|\.vtt(?:$|\?)|\.srt(?:$|\?)|\.ttml(?:$|\?)|\.dfxp(?:$|\?)|\.smi(?:$|\?)|\.m3u8(?:$|\?))/i;
  const TYPE_HINT = /(?:text\/vtt|application\/ttml\+xml|application\/x-subrip|application\/vnd\.apple\.mpegurl|application\/x-mpegurl)/i;

  function bodyLooksLikeCaptions(text) {
    const sample = String(text || '').slice(0, 12000);
    return /^WEBVTT/m.test(sample) || /-->/.test(sample) || /<tt(?:\s|>)/i.test(sample) || /<sync\b/i.test(sample) || /"(?:tStartMs|dDurationMs|caption|subtitle|cues|timedText)"\s*:/i.test(sample) || /#EXT-X-MEDIA:.*TYPE=SUBTITLES/i.test(sample);
  }

  function shouldInspect(url, contentType) {
    return URL_HINT.test(String(url || '')) || TYPE_HINT.test(String(contentType || ''));
  }

  function formatHint(url, contentType, text) {
    const value = `${url || ''} ${contentType || ''}`.toLowerCase();
    if (/webvtt|\.vtt/.test(value) || /^WEBVTT/m.test(text || '')) return 'WebVTT';
    if (/ttml|dfxp/.test(value) || /<tt(?:\s|>)/i.test(text || '')) return 'TTML/DFXP';
    if (/\.srt/.test(value) || /\d\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text || '')) return 'SRT';
    if (/\.smi|sami/.test(value) || /<sync\b/i.test(text || '')) return 'SAMI';
    if (/m3u8|mpegurl/.test(value) || /^#EXTM3U/m.test(text || '')) return 'HLS playlist';
    if (/json/.test(value) || /^[\s\r\n]*[\[{]/.test(text || '')) return 'JSON captions';
    return 'Timed text';
  }

  function publish(url, contentType, text, via) {
    if (!text || text.length > MAX_TEXT) return;
    if (!shouldInspect(url, contentType) && !bodyLooksLikeCaptions(text)) return;
    if (!bodyLooksLikeCaptions(text) && !/(?:\.vtt|\.srt|\.ttml|\.dfxp|\.smi)(?:$|\?)/i.test(String(url || ''))) return;
    try {
      window.postMessage({
        source: 'opensub-network-probe',
        payload: {
          url: String(url || location.href),
          contentType: String(contentType || ''),
          text: String(text),
          via: String(via || ''),
          format: formatHint(url, contentType, text),
          capturedAt: Date.now()
        }
      }, '*');
    } catch (_) {}
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const request = args[0];
        const url = typeof request === 'string' ? request : (request?.url || response.url || '');
        const contentType = response.headers?.get?.('content-type') || '';
        if (shouldInspect(url, contentType)) {
          response.clone().text().then(text => publish(url, contentType, text, 'fetch')).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR?.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function(method, url, ...rest) {
      try { this.__openSubUrl = new URL(String(url), location.href).href; } catch (_) { this.__openSubUrl = String(url || ''); }
      return originalOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function(...args) {
      if (!this.__openSubListenerAttached) {
        this.__openSubListenerAttached = true;
        this.addEventListener('load', () => {
          try {
            const url = this.responseURL || this.__openSubUrl || '';
            const contentType = this.getResponseHeader?.('content-type') || '';
            if (!shouldInspect(url, contentType)) return;
            let text = '';
            if (!this.responseType || this.responseType === 'text') text = this.responseText || '';
            else if (this.responseType === 'json') text = JSON.stringify(this.response || null);
            else if (this.responseType === 'arraybuffer' && this.response) text = new TextDecoder('utf-8').decode(this.response);
            else if (this.responseType === 'blob' && this.response?.text) {
              this.response.text().then(value => publish(url, contentType, value, 'xhr-blob')).catch(() => {});
              return;
            }
            if (text) publish(url, contentType, text, 'xhr');
          } catch (_) {}
        });
      }
      return originalSend.apply(this, args);
    };
  }
})();

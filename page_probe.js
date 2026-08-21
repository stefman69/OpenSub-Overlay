(() => {
  'use strict';
  if (window.__openSubNetworkProbeInstalled) return;
  window.__openSubNetworkProbeInstalled = true;

  const MAX_TEXT = 3 * 1024 * 1024;
  const REPLAY_LIMIT = 8;
  const recentPayloads = [];
  let replaySessionKey = '';

  const URL_HINT = /(?:caption|captions|subtitle|subtitles|timedtext|texttrack|webvtt|ttml|dfxp|\.vtt(?:$|\?)|\.srt(?:$|\?)|\.ttml(?:$|\?)|\.dfxp(?:$|\?)|\.smi(?:$|\?)|\.m3u8(?:$|\?))/i;
  const TYPE_HINT = /(?:text\/vtt|application\/ttml\+xml|application\/x-subrip|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|application\/dash\+xml)/i;
  const METADATA_URL_HINT = /(?:\/api(?:\/|$)|player|playback|media|video|asset|stream|content|ptmd|profile|config|metadata|graphql|teaser|frontend|manifest|playlist|\.mpd(?:$|\?))/i;
  const METADATA_TYPE_HINT = /(?:application\/(?:json|[^;]+\+json|xml|[^;]+\+xml)|text\/xml)/i;

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
      return String(raw || '').split('#')[0];
    }
  }

  function syncReplaySession() {
    const next = navigationSessionKey(location.href);
    if (!replaySessionKey) replaySessionKey = next;
    if (next !== replaySessionKey) {
      replaySessionKey = next;
      recentPayloads.length = 0;
    }
    return replaySessionKey;
  }

  function payloadKey(payload) {
    const rawUrl = String(payload?.url || '');
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
          u.searchParams.get('fmt') || payload?.format || ''
        ].join('|');
      }
    } catch (_) {}
    return `${rawUrl}|${payload?.format || ''}|${payload?.text?.length || 0}`;
  }

  function rememberReplayPayload(payload) {
    syncReplaySession();
    const key = payloadKey(payload);
    const existing = recentPayloads.findIndex(item => payloadKey(item) === key);
    if (existing >= 0) recentPayloads.splice(existing, 1);
    recentPayloads.unshift(payload);
    if (recentPayloads.length > REPLAY_LIMIT) recentPayloads.length = REPLAY_LIMIT;
  }

  function emitPayload(payload) {
    try {
      window.postMessage({ source: 'opensub-network-probe', payload }, '*');
    } catch (_) {}
  }

  function bodyLooksLikeCaptions(text) {
    const sample = String(text || '').slice(0, 12000);
    return /^WEBVTT/m.test(sample) || /-->/.test(sample) || /<(?:[a-z0-9_.-]+:)?tt(?:\s|>)/i.test(sample) || /<(?:[a-z0-9_.-]+:)?p\b[^>]*(?:begin|end|dur)\s*=/i.test(sample) || /<sync\b/i.test(sample) || /"(?:tStartMs|dDurationMs|caption|subtitle|cues|timedText)"\s*:/i.test(sample) || /#EXT-X-MEDIA:.*TYPE=SUBTITLES/i.test(sample);
  }

  function shouldInspect(url, contentType) {
    return URL_HINT.test(String(url || '')) || TYPE_HINT.test(String(contentType || ''));
  }

  function shouldInspectMetadata(url, contentType) {
    const rawUrl = String(url || '');
    const type = String(contentType || '');
    return METADATA_URL_HINT.test(rawUrl) && (METADATA_TYPE_HINT.test(type) || /(?:\.json|\.xml|\.mpd)(?:$|[?#])/i.test(rawUrl));
  }

  function emitMetadata(url, contentType, text, via) {
    if (!text || text.length > MAX_TEXT) return;
    try {
      window.postMessage({
        source: 'opensub-subtitle-metadata',
        payload: {
          url: String(url || location.href),
          contentType: String(contentType || ''),
          text: String(text),
          via: String(via || ''),
          capturedAt: Date.now()
        }
      }, '*');
    } catch (_) {}
  }

  function formatHint(url, contentType, text) {
    const value = `${url || ''} ${contentType || ''}`.toLowerCase();
    if (/webvtt|\.vtt/.test(value) || /^WEBVTT/m.test(text || '')) return 'WebVTT';
    if (/ebu-?tt|ebutt/.test(value) || /EBU-TT-D/i.test(text || '')) return 'EBU-TT-D / TTML';
    if (/ttml|dfxp/.test(value) || /<(?:[a-z0-9_.-]+:)?tt(?:\s|>)/i.test(text || '')) return 'TTML/DFXP';
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
    syncReplaySession();
    const payload = {
      url: String(url || location.href),
      contentType: String(contentType || ''),
      text: String(text),
      via: String(via || ''),
      format: formatHint(url, contentType, text),
      capturedAt: Date.now()
    };
    rememberReplayPayload(payload);
    emitPayload(payload);
  }

  window.addEventListener('message', event => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.source !== 'opensub-network-probe-control') return;
      if (data.type !== 'opensub-replay-current-captions') return;
      syncReplaySession();
      // Snapshot first so replay cannot be disturbed if a page message mutates the cache mid-loop.
      // Replay only payloads captured in this exact navigation session.
      const replay = recentPayloads.slice().reverse();
      for (const payload of replay) emitPayload(payload);
    } catch (_) {
      // MAIN-world pages can dispatch unusual MessageEvent payloads. Probe failures must never
      // escape into the site's execution context or Chrome's extension error page.
    }
  });

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    try {
      // Do not use an async wrapper here. Returning the exact Promise created by the page's native
      // fetch keeps the site's fetch/rejection semantics untouched. OpenSub only observes a side
      // branch of that Promise and consumes failures on the observer branch itself.
      window.fetch = new Proxy(originalFetch, {
        apply(target, thisArg, args) {
          const pending = Reflect.apply(target, thisArg, args);
          try {
            if (pending && typeof pending.then === 'function') {
              pending.then(response => {
                try {
                  const request = args[0];
                  const url = typeof request === 'string' ? request : (request?.url || response?.url || '');
                  const contentType = response?.headers?.get?.('content-type') || '';
                  const inspectTimed = shouldInspect(url, contentType);
                  const inspectMetadata = shouldInspectMetadata(url, contentType);
                  if (!inspectTimed && !inspectMetadata) return;
                  let clone;
                  try { clone = response.clone(); } catch (_) { return; }
                  clone.text().then(
                    text => {
                      try { if (inspectTimed) publish(url, contentType, text, 'fetch'); } catch (_) {}
                      try { if (inspectMetadata) emitMetadata(url, contentType, text, 'fetch-metadata'); } catch (_) {}
                    },
                    () => {}
                  );
                } catch (_) {}
              }, () => {});
            }
          } catch (_) {}
          return pending;
        }
      });
    } catch (_) {
      // Some pages make fetch non-writable or otherwise protect it. In that case leave the page's
      // fetch completely untouched; XHR/network detection continues to operate independently.
    }
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
            const inspectTimed = shouldInspect(url, contentType);
            const inspectMetadata = shouldInspectMetadata(url, contentType);
            if (!inspectTimed && !inspectMetadata) return;
            let text = '';
            if (!this.responseType || this.responseType === 'text') text = this.responseText || '';
            else if (this.responseType === 'json') text = JSON.stringify(this.response || null);
            else if (this.responseType === 'arraybuffer' && this.response) text = new TextDecoder('utf-8').decode(this.response);
            else if (this.responseType === 'blob' && this.response?.text) {
              this.response.text().then(value => {
                try { if (inspectTimed) publish(url, contentType, value, 'xhr-blob'); } catch (_) {}
                try { if (inspectMetadata) emitMetadata(url, contentType, value, 'xhr-blob-metadata'); } catch (_) {}
              }).catch(() => {});
              return;
            }
            if (text) {
              if (inspectTimed) publish(url, contentType, text, 'xhr');
              if (inspectMetadata) emitMetadata(url, contentType, text, 'xhr-metadata');
            }
          } catch (_) {}
        });
      }
      return originalSend.apply(this, args);
    };
  }
})();

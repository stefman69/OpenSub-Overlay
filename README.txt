OpenSub Overlay v1
====================

NORMAL COMPLETE-TRACK WORKFLOW
------------------------------
1. Open the video and turn the site's original captions on.
2. Play several seconds.
3. Open OpenSub Overlay and click Refresh detection.
4. Use the first available method:
   A. HTML5 subtitle track
   B. Timed-text network resource
   C. Import your own subtitle file
5. Choose source/target languages.
6. Translate & overlay.
7. The completed translation is stored and auto-loads next time.

LIVE CUSTOM-PLAYER WORKFLOW
---------------------------
Use this when the original captions are visibly playing but OpenSub cannot extract a complete track.

1. Turn the site's captions on and let a caption appear.
2. Open OpenSub and click Refresh detection.
3. If “Custom/DOM caption text detected” appears, choose source/target languages.
4. Click Start live translation.
5. You may close the popup. A hidden extension document keeps Chrome's Translator API available and translates each changing caption.

Live translation is a fallback. Because it translates captions as they appear, there can be a small delay compared with translating a complete subtitle file up front.

HULU / CUSTOM PLAYERS
---------------------
OpenSub does not contain Hulu credentials, does not bypass Hulu access controls or DRM, and does not download Hulu video.

Hulu and similar players may not expose their captions through HTML5 TextTrack. v4 therefore this captures network timed-text detection and visible custom-caption DOM detection too. If a site renders captions entirely into a canvas or supplies captions only as inaccessible/encrypted data, OpenSub cannot reliably read that text without a separate OCR/speech-recognition system.

NETWORK CAPTURE PRIVACY
-----------------------
The page probe only clones responses that look caption-related by URL/content type and only retains likely timed-text payloads in extension memory. It does not transmit them to an OpenSub server. There is no OpenSub server, analytics, or account system.

SUPPORTED IMPORT / CAPTURE FORMATS
----------------------------------
Best support:
- SRT
- WebVTT
- TTML / DFXP
- SAMI
- Common JSON timed-text structures (including tStartMs/dDurationMs style events)

HLS .m3u8 subtitle playlists can be recognized, but the playlist itself is not a subtitle file. Keep captions playing so OpenSub can capture the referenced VTT/TTML text resources or segments.

TRANSLATION
-----------
Chrome desktop 138+ is required. OpenSub uses Chrome's built-in Language Detector and Translator APIs. Translation models may download the first time a language pair is used. No external translation API key is required.

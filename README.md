# OpenSub-Overlay
For translating video subtitles to multiple languages across multiple video and streaming services, with the intention of being used for language learning. 

# SRT FILE DOWNLOAD WORKFLOW

1. Open the video and turn the site's original captions on.
2. Play several seconds.
3. Open OpenSub Overlay and click Refresh detection if needed.
4. Use the first available method:
   A. HTML5 subtitle track
   B. Timed-text network resource
   C. Import your own subtitle file
5. Choose source/target languages.
6. Translate & overlay.
7. The completed translation is stored and auto-loads anytime the video is played 

# LIVE SUBTITLE WORKFLOW

Use this when the original captions are visibly playing but OpenSub cannot download a subtitle file.

1. Turn the site's captions on and let a caption appear.
2. Open OpenSub Overlay Extendion and click Refresh detection.
3. If “Custom/DOM caption text detected” appears, choose source/target languages.
4. Click Start live translation.
5. If you want only the translated subtitle check the box to disable original subtitles.

Live translation is a fallback. Because it translates captions as they appear, there can be a small delay compared with translating a complete subtitle file up front.

# SUPPORTED IMPORT / CAPTURE FORMATS

Best support:
- SRT
- WebVTT
- TTML / DFXP
- SAMI
- Common JSON timed-text structures (including tStartMs/dDurationMs style events)

HLS .m3u8 subtitle playlists can be recognized, but the playlist itself is not a subtitle file. Keep captions playing so OpenSub can capture the referenced VTT/TTML text resources or segments.

# TRANSLATION

Chrome desktop 138+ is required. OpenSub uses Chrome's built-in Language Detector and Translator APIs. Translation models may download the first time a language pair is used.

# NETWORK CAPTURE PRIVACY

The page probe only clones responses that look caption-related based on URL/content type and only retains likely timed-text payloads in the extensions memory. It does not transmit them to an OpenSub server. There is no OpenSub server, analytics, or account system.

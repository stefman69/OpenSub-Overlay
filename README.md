# OpenSub-Overlay

For translating video subtitles to multiple languages across most video and streaming services, with the intention of being used for language learning. This is my first Google Chrome extension so any feedback on websites that did not work for you or any other issues encountered while using it would be greatly appreciated. 

If you use and like the extension, consider buying me a coffee!

https://buymeacoffee.com/stefman69

# Installation Instructions

Google chrome has approved my extension their store and it can be downloaded here: https://chromewebstore.google.com/detail/opensub-overlay/bgoikhnecpbdhpmhpbdhjidibogdcopp

Or optionally you can install it from the archive on my release page; 

1. Download the latest release zip file. It can be found here: https://github.com/stefman69/OpenSub-Overlay/releases/tag/v1.0
2. Extract the folder from the zipped archive.
3. In the Google Chrome desktop application click on the puzzle piece icon at the top and select manage extensions at the bottom

   *if no puzzle piece icon is present you will need to click the three dots in the top right, select extensions then manage extensions

   *OpenSub may work on Android alternative Chromium-based browsers that allow extensions like Kiwi Browser or Yandex Browser, but has not been tested on those platforms.
   
4. On the manage extensions page turn on the developer toggle in the top right corner.
5. At the top left under where it says extensions an option should appear that says "Load unpacked" select this option and then navigate to the extracted, most likely in your computer downloads. Click on thr OpenSub_Overlay folder and then click the select folder option.

# How To Video
For detailed instructions on using OpenSub Overlay please watch the video on my YouTube channel: https://youtu.be/Gs_IkVPzHX8?is=gWsH4z76U-JLAJg-

Or read below:

# FIND ON PAGE WORKFLOW

1. Open the video and turn the site's original captions on.
2. Play several seconds.
3. Open OpenSub Overlay and click Refresh detection if needed.
4. If a subtitle track is detected select it from the detected subtitle tracks dropdown. Alternatively, upload your own original subtitle file.  
5. Choose source/target languages.
6. Choose **Translate with Chrome** for local machine translation, or **Use translated subtitle file** to pair the website/uploaded original with your own translated SRT/VTT/TTML/JSON file. OpenSub checks the two timelines and can correct a consistent translated-file offset before saving.
7. Translate & overlay (or use the supplied translated file).
8. Once the OpenSub translation is displaying, **turn off the website/player's own captions if they are still visible.** OpenSub already redraws the original subtitle beneath the translation, so leaving the player's captions enabled can create a third duplicate subtitle on some sites. OpenSub may passively suppress duplicate caption renderers when it can identify them safely, but it does **not** click or change a website's CC/subtitle controls. This note applies to file/downloaded subtitle translation; Live translation may still require the site's captions to remain enabled so OpenSub can keep receiving new caption text.
9. The completed translation is stored and auto-loads anytime the video is played.

# LIVE CAPTIONS WORKFLOW

Use this when the original captions are visibly playing but OpenSub cannot download a subtitle file.

1. Turn the site's captions on and let the video play until captions appear.
2. Open OpenSub Overlay extension and click the live captions option at the top of the extension.
3. Click Refresh detection if no live subtitles are detected.
4. If “Custom/DOM caption text detected” appears, choose source/target languages.
5. Click Start live translation.
6. If you want only the translated subtitle check the box to disable original subtitles.

Live translation is a fallback. Because it translates captions as they appear, there can be a small delay compared with translating a complete subtitle file up front.

# UPLOAD SUBS WORKFLOW

1. Click the Upload Subs box at the top of the extension.
2. Scroll down and click the box that says Choose file.
3. Navigate to and select your subtitle file and upload it.
    3a. Or select the dropdown for opensubtitles.com (you will need to log into an opensubtitle account that you have made on there website in         the account dropdown in this menu, but doing so will allow you to search for and download subtitles in the extension)
4. Once you have a file pulled up scroll down and select translate and overlay, or set the translation method as use translated subtitle file and use your own.
5. If you want only the translated subtitle check the box to disable original subtitles.

# BATCH MULTIPLE SUBTITLES AND DOWNLOAD THEM

This extension also allows for adding as many subtitles as you want at once and can translate them all together. You can then download them as either dual subtitle files or as just translated subtitles. The steps are largely the same as the single upload subs workflow, you just need to select the batch toggle at the top of the extension.

# SUPPORTED IMPORT / CAPTURE FORMATS

Best support:
- SRT
- WebVTT
- TTML / DFXP
- EBU-TT-D / EBU-TT-D-Basic-DE (namespaced TTML used by ARD/KiKA and other broadcasters)
- SAMI
- Common JSON timed-text structures (including tStartMs/dDurationMs style events)

OpenSub also performs local subtitle-resource discovery for players that hide their captions behind JSON/XML playback metadata or HLS/DASH manifests. When those resources expose a normal VTT/TTML/EBU-TT-D/SRT sidecar, OpenSub follows the player-provided URL and offers the resolved timed-text file in the same detected-subtitle dropdown. Fragmented binary subtitle tracks inside media containers are not decoded.

# TRANSLATION

Chrome desktop 138+ is required. OpenSub uses Chrome's built-in Language Detector and Translator APIs. Translation models may download the first time a language pair is used.

# NETWORK CAPTURE PRIVACY

The page/runtime probes inspect caption-like responses plus limited player metadata/manifests in order to discover subtitle sidecar URLs. Discovery and any follow-up resource fetches happen locally in the browser using only URLs already requested or referenced by the page/player. Timed-text payloads are kept only in extension memory unless you choose to translate/save them. Nothing is transmitted to an OpenSub server. There is no OpenSub server, analytics, or account system.


# COMPLETE-SUBTITLE QUALITY AND TIMING

For uploaded or captured/downloaded complete subtitle files, OpenSub translates across sentence boundaries when punctuation makes them clear instead of translating arbitrary line breaks independently. The resulting translated sentence is then distributed back across the original cue timing. Live captions and rolling/replaced live TextTracks keep their low-latency cue-by-cue behavior.

Saved subtitle timing can be adjusted by ±0.1, ±0.25, ±1, or ±5 seconds. OpenSub privately remembers manual timing corrections per website in `chrome.storage.local`. After at least two similar corrections on different saved pages from the same site, it uses their local average as the starting offset for future complete-subtitle tracks on that site. Outlying corrections are not included in the learned value, and **Forget learned timing for this site** deletes the local timing profile. No timing observations are transmitted anywhere.

When using your own translated subtitle file, any offset used to align that translated file to the original is stored with the subtitle pair and is deliberately kept separate from the learned website timing profile.

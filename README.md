# Danloader

A browser extension for finding and downloading videos on a page, with quality selection and a shared save folder.

[Русский](README.ru.md)

![Preview](preview.png)

## Supported services

- YouTube
- Instagram
- Boosty
- Kinescope (including embeds on Sponsr)

Other sites: best-effort detection of HTML video and HLS/DASH streams.

## Installation

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode and click **Load unpacked**.
3. Select the `video-downloader/dist` folder.
4. Reload the video page and start playback.

Open Danloader, choose a quality, and click **Download**. Select a save folder at the top of the panel to use it for all videos.

[Support details](docs/SUPPORT.md) · [Verification results](docs/VERIFICATION.md) (in Russian)

Development: `npm ci`, then `npm run build`. Run `npm run typecheck` to check TypeScript.

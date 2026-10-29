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

## Install

### Chrome Web Store

The store link will be added after publication.

### Manual

1. Download the extension ZIP from [GitHub Releases](https://github.com/karozero/danloader/releases/latest) and extract it to a permanent folder.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode** and click **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Reload the video page and start playback.

Open Danloader, choose a quality, and click **Download**. Select a save folder at the top of the panel to use it for all videos.

[Support details](docs/SUPPORT.md) · [Verification results](docs/VERIFICATION.md) (in Russian)

## Building

Requires Node.js 22 or newer and npm. Download or clone the source code, then open a terminal in the project folder containing `package.json`:

```sh
npm ci
npm run build
```

The built extension is in `dist`. Load this folder using **Load unpacked** as described above.

Run `npm test` to build and run unit tests, or `npm run typecheck` to check TypeScript.

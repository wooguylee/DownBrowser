# DownBrowser

`DownBrowser` is a Node.js CLI tool for testing browser-based video delivery flows with Playwright and the Chrome DevTools Protocol (CDP).

It opens a real browser, watches network traffic at the page level, detects HLS manifests and segment requests, and saves the selected stream as a single local file.

This project is intended for authorized testing of your own service or content that you are permitted to inspect.

## Features

- Launch Chromium with Playwright and inspect traffic through CDP
- Detect HLS manifests (`.m3u8`) and media segments (`.ts`, `m4s`, etc.)
- Download a manifest directly or discover it from a live page
- Interactive terminal mode for browser control while the page stays open
- Start the browser first, then open pages from CLI or navigate manually in the browser
- List detected sources, video elements, and page buttons
- Start and stop recording from the terminal
- Multi-tab support with separate tracking state per tab
- Save merged media output and JSON metadata

## Requirements

- Node.js 20+
- npm
- Playwright Chromium browser installed

## Installation

```bash
npm install
npx playwright install chromium
```

## Quick Start

### 1. Direct manifest download

```bash
node index.js --manifest-url "https://example.com/path/playlist.m3u8" --name sample
```

### 2. Open a page and auto-detect the stream

```bash
node index.js --url "https://example.com/watch/123" --headful
```

### 3. Start in interactive mode

```bash
node index.js --interactive
```

Then either:

- run `open <url>` in the terminal, or
- type a URL directly into the browser and run `scan`

## CLI Usage

```bash
node index.js --url <page-url> [options]
node index.js --manifest-url <m3u8-url> [options]
node index.js --interactive [--url <page-url>] [options]
```

### Options

- `--url <url>`: open a page and detect HLS traffic
- `--manifest-url <url>`: skip page discovery and download directly from a known manifest
- `--interactive`: keep the browser open and control it from the terminal
- `--output-dir <dir>`: output directory, default `./downloads`
- `--name <name>`: base file name for the saved output
- `--headful`: launch Chromium with UI
- `--headless`: force headless mode
- `--timeout-ms <ms>`: page navigation timeout
- `--poll-seconds <sec>`: live playlist polling fallback
- `--max-empty-polls <count>`: stop live polling after repeated empty refreshes
- `--settle-ms <ms>`: wait time after page load before scan completes
- `--help`: show help

## Interactive Mode

Interactive mode is the main workflow when you want to inspect a page manually and choose what to record.

Start it with:

```bash
npm run interactive
```

or:

```bash
node index.js --interactive --output-dir downloads
```

### Common workflow

```text
open https://example.com/watch/123
scan
sources
record 0 my-video
status
stop
exit
```

### Example console session

```text
$ node index.js --interactive --output-dir downloads
Browser ready.
Use `open <url>` from the terminal, or type a URL directly in the browser and then run `scan`.
Commands: help, tabs, new-tab, use-tab <n>, close-tab [n], open <url>, scan, videos, buttons, sources, clear, play [n], pause [n], click-button <n>, click <selector>, press <key>, refresh, reload, record [n] [name], stop, status, exit

downbrowser[t1]> open https://example.com/watch/123
Loaded: Example Video Page
Detected manifests:
  [0] segments=120 variants=0 endList=yes https://cdn.example.com/video/master.m3u8

downbrowser[t1]> status
Page: Example Video Page
URL: https://example.com/watch/123
Tab: 1
Tracker scope: 3 last reset=2026-03-09 07:47:59
Sources: 1
Sources fresh for current page: yes
Last scan: 2026-03-09 07:48:01 title="Example Video Page" url=https://example.com/watch/123 sources=1 videos=1
Video[0]: paused=false time=2.114/634.584
Recording: idle

downbrowser[t1]> record 0 example-save
Recording started from tab 1, source 0: https://cdn.example.com/video/master.m3u8
[segment 1] 1915156 bytes https://cdn.example.com/video/file_000.ts
[segment 2] 4182812 bytes https://cdn.example.com/video/file_001.ts

downbrowser[t1]> stop
Stop requested for tab 1. Waiting for current segment to finish...

[recording] saved 2 segment(s), 5.82 MB
[recording] video: .../downloads/example-save.ts
[recording] metadata: .../downloads/example-save.json
```

### Manual browser navigation workflow

```text
# 1. Start the tool
node index.js --interactive

# 2. In the browser, type a URL and open the page

# 3. Back in the terminal
scan
sources
record 0 my-video
```

### Commands

- `help`: show help text
- `tabs`: list open tabs
- `new-tab`: create a new tab
- `use-tab <n>`: switch current tab
- `close-tab [n]`: close a tab, default is current tab
- `open <url>`: navigate the current tab to a URL
- `scan`: scan the current page and refresh detected sources
- `videos`: list `video` elements on the current page
- `buttons`: list buttons on the current page
- `sources`: list detected manifests and source freshness info
- `clear`: clear tracked sources for the current tab
- `play [n]`: try to play video element `n`, default `0`
- `pause [n]`: pause video element `n`, default `0`
- `click-button <n>`: click button by index
- `click <selector>`: click the first matching selector
- `press <key>`: send a keyboard key, for example `Space`
- `refresh`: nudge playback and print current sources/videos
- `reload`: reload the current page and re-scan
- `record [n] [name]`: start recording source `n`, optionally with a custom file name
- `stop`: stop the active recording after the current segment finishes
- `status`: show page status, tracker scope, scan freshness, and recording progress
- `exit`: stop recording if needed and exit

## Multi-Tab Operation

Each tab has its own tracker state.

- source detection is isolated per tab
- switching tabs does not mix manifests from other tabs
- `record` always uses the current tab's detected sources
- `status` shows which tab is active and whether the current sources are fresh for that page

Example:

```text
new-tab
open https://example.com/a
scan

new-tab
open https://example.com/b
scan

tabs
use-tab 1
record 0 first-video
```

## Output Files

When recording succeeds, the tool writes:

- `<name>.ts`: merged transport stream output
- `<name>.json`: metadata including manifest URL, segments, sizes, and totals

Example output directory:

```text
downloads/
  my-video.ts
  my-video.json
```

## FFmpeg Post-Processing

The tool currently saves merged output as a transport stream file such as `my-video.ts`.

If you want a more widely compatible container, you can remux the file with `ffmpeg` without re-encoding:

```bash
ffmpeg -i downloads/my-video.ts -c copy downloads/my-video.mp4
```

Useful variants:

- basic remux:

```bash
ffmpeg -i downloads/my-video.ts -c copy downloads/my-video.mp4
```

- overwrite existing output:

```bash
ffmpeg -y -i downloads/my-video.ts -c copy downloads/my-video.mp4
```

- inspect the saved file first:

```bash
ffprobe downloads/my-video.ts
```

Notes:

- `-c copy` keeps the original audio/video streams and avoids re-encoding
- if the source stream is not compatible with MP4, remux to MKV instead:

```bash
ffmpeg -i downloads/my-video.ts -c copy downloads/my-video.mkv
```

- the JSON metadata file remains useful even after remuxing

## Status and Freshness

`status` shows:

- current tab id
- current page title and URL
- tracker scope id
- last tracker reset time
- whether sources are fresh for the current page
- last scan time and scan target page
- recording progress, bytes, and latest segment

`record` is blocked when the tracked sources are stale for the current page. In that case, run `scan` or `reload` first.

## Notes

- Some sites behave differently in `headless` mode. If detection fails, try `--headful` or interactive mode.
- Stopping a recording is graceful: the current segment finishes first, then the output file is finalized.
- If you manually navigate in the browser, run `scan` before `record`.
- If a site loads media only after user interaction, use `play`, `click-button`, `click`, or `press` first.

## Scripts

`package.json` includes:

```bash
npm run download
npm run interactive
```

## Project Files

- `index.js`: main CLI, interactive mode, CDP tracking, and download logic
- `demo.html`: local HLS demo page
- `server.js`: simple static file server for local testing

## Example Local Test

```bash
node index.js --interactive
open file:///Z:/Work/WorkAI/DownBrowser/demo.html
scan
record 0 demo-test
```

## Troubleshooting

### No sources detected

- try `scan`
- try `play 0`
- try `reload`
- try `--headful`

### Sources are stale for current page

- navigate to the target page again
- run `scan` or `reload`
- confirm with `status` that freshness is `yes`

### Wrong tab selected

- run `tabs`
- switch with `use-tab <n>`
- verify with `status`

## License

ISC

## Korean Documentation

- Korean guide: `README.ko.md`

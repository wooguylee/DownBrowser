#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { chromium } = require('playwright');
const { Parser } = require('m3u8-parser');

function printHelp() {
  console.log(`Usage:
  node index.js --url <page-url> [options]
  node index.js --manifest-url <m3u8-url> [options]
  node index.js --interactive [--url <page-url>] [options]

Options:
  --url <url>                 Open a page in Chromium and auto-detect HLS traffic.
  --manifest-url <url>        Skip page discovery and download directly from a known manifest.
  --interactive               Keep the browser open and control playback/recording from the terminal.
  --output-dir <dir>          Output directory. Default: ./downloads
  --name <name>               Base file name for saved output.
  --headful                   Launch Chromium with UI.
  --headless                  Force headless mode.
  --timeout-ms <ms>           Discovery timeout. Default: 45000
  --poll-seconds <sec>        Live playlist poll interval fallback. Default: 4
  --max-empty-polls <count>   Stop live polling after N empty refreshes. Default: 3
  --settle-ms <ms>            Wait after navigation before capture ends. Default: 12000
  --help                      Show this help.

Interactive commands:
  help, open <url>, scan, videos, buttons, sources, clear, play [n],
  pause [n], click-button <n>, click <selector>, press <key>, refresh,
  reload,
  record [n] [name], stop, status, exit

Examples:
  node index.js --url "https://example.com/watch/123"
  node index.js --url "https://example.com/watch/123" --interactive
  node index.js --interactive
  node index.js --manifest-url "https://cdn.example.com/media/playlist.m3u8" --name sample
`);
}

function parseArgs(argv) {
  const options = {
    outputDir: path.resolve(process.cwd(), 'downloads'),
    headless: true,
    interactive: false,
    timeoutMs: 45000,
    pollSeconds: 4,
    maxEmptyPolls: 3,
    settleMs: 12000,
    _headlessExplicit: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--url') {
      options.url = argv[++i];
    } else if (arg === '--manifest-url') {
      options.manifestUrl = argv[++i];
    } else if (arg === '--interactive') {
      options.interactive = true;
    } else if (arg === '--output-dir') {
      options.outputDir = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === '--name') {
      options.name = argv[++i];
    } else if (arg === '--headful') {
      options.headless = false;
      options._headlessExplicit = true;
    } else if (arg === '--headless') {
      options.headless = true;
      options._headlessExplicit = true;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++i]);
    } else if (arg === '--poll-seconds') {
      options.pollSeconds = Number(argv[++i]);
    } else if (arg === '--max-empty-polls') {
      options.maxEmptyPolls = Number(argv[++i]);
    } else if (arg === '--settle-ms') {
      options.settleMs = Number(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.interactive && !options._headlessExplicit) {
    options.headless = false;
  }

  delete options._headlessExplicit;
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFileName(value) {
  return String(value || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'video';
}

function lowerCaseHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[String(key).toLowerCase()] = String(value);
  }
  return normalized;
}

function looksLikeManifest(url, mimeType) {
  return /\.m3u8(?:$|[?#])/i.test(url) || /mpegurl|vnd\.apple\.mpegurl/i.test(mimeType || '');
}

function looksLikeSegment(url, mimeType) {
  return /\.(?:ts|m4s|mp4|aac)(?:$|[?#])/i.test(url) || /video\/|audio\//i.test(mimeType || '');
}

function resolveUrl(baseUrl, relativeUrl) {
  return new URL(relativeUrl, baseUrl).toString();
}

function parseManifest(text) {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  return parser.manifest;
}

function chooseVariant(manifest, manifestUrl) {
  const candidates = (manifest.playlists || []).filter((item) => item.uri);
  if (candidates.length === 0) {
    throw new Error(`No variant playlists found in ${manifestUrl}`);
  }

  candidates.sort((left, right) => {
    const leftBandwidth = left.attributes?.BANDWIDTH || 0;
    const rightBandwidth = right.attributes?.BANDWIDTH || 0;
    return rightBandwidth - leftBandwidth;
  });

  return resolveUrl(manifestUrl, candidates[0].uri);
}

async function cookieHeaderFor(context, url) {
  const cookies = await context.cookies(url);
  if (cookies.length === 0) {
    return '';
  }
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function buildFetchHeaders(context, url, requestHeaders, referer) {
  const headers = {
    accept: '*/*',
  };
  const source = lowerCaseHeaders(requestHeaders);
  const cookieHeader = await cookieHeaderFor(context, url);

  if (source['user-agent']) {
    headers['user-agent'] = source['user-agent'];
  }
  if (source.authorization) {
    headers.authorization = source.authorization;
  }
  if (source.origin) {
    headers.origin = source.origin;
  }
  if (referer || source.referer) {
    headers.referer = referer || source.referer;
  }
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  return headers;
}

async function fetchBuffer(url, headers) {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const responseHeaders = {};
  for (const [key, value] of response.headers.entries()) {
    responseHeaders[key.toLowerCase()] = value;
  }

  return {
    status: response.status,
    headers: responseHeaders,
    buffer: Buffer.from(arrayBuffer),
  };
}

async function fetchText(url, headers) {
  const { buffer, headers: responseHeaders } = await fetchBuffer(url, headers);
  return {
    text: buffer.toString('utf8'),
    headers: responseHeaders,
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function tokenizeCommand(line) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(line))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function parseIndex(value, fallback = 0) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid index: ${value}`);
  }
  return parsed;
}

function rankSources(sources) {
  return [...sources].sort((left, right) => {
    if ((right.segmentCount || 0) !== (left.segmentCount || 0)) {
      return (right.segmentCount || 0) - (left.segmentCount || 0);
    }
    if ((right.playlistCount || 0) !== (left.playlistCount || 0)) {
      return (right.playlistCount || 0) - (left.playlistCount || 0);
    }
    return new Date(left.firstSeenAt).getTime() - new Date(right.firstSeenAt).getTime();
  });
}

async function nudgePlayback(page) {
  await page.evaluate(() => {
    for (const video of document.querySelectorAll('video')) {
      video.muted = true;
      const promise = video.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => {});
      }
    }
  }).catch(() => {});

  const video = page.locator('video').first();
  if ((await video.count().catch(() => 0)) > 0) {
    await video.click({ force: true }).catch(() => {});
  }
}

async function getVideoElements(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('video')).map((video, index) => ({
      index,
      src: video.src,
      currentSrc: video.currentSrc,
      poster: video.poster,
      paused: video.paused,
      muted: video.muted,
      controls: video.controls,
      readyState: video.readyState,
      currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(3)) : null,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
    }));
  }).catch(() => []);
}

async function getButtons(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map((button, index) => {
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      return {
        index,
        text: button.innerText.trim(),
        className: button.className,
        visible,
      };
    }).filter((button) => button.text || button.visible);
  }).catch(() => []);
}

function createNetworkTracker(session) {
  const requests = new Map();
  const requestToManifest = new Map();
  const manifests = new Map();
  const recentSegments = [];
  let scopeId = 0;
  let enabled = false;

  session.on('Network.requestWillBeSent', (event) => {
    requests.set(event.requestId, {
      url: event.request.url,
      headers: lowerCaseHeaders(event.request.headers || {}),
      scopeId,
    });
  });

  session.on('Network.responseReceived', (event) => {
    const url = event.response.url;
    const mimeType = event.response.mimeType || '';
    const now = new Date().toISOString();

    if (looksLikeManifest(url, mimeType)) {
      const existing = manifests.get(url);
      const requestInfo = requests.get(event.requestId);
      const requestScopeId = requestInfo?.scopeId ?? scopeId;
      if (requestScopeId !== scopeId) {
        return;
      }
      manifests.set(url, {
        url,
        mimeType,
        status: event.response.status,
        requestHeaders: requestInfo?.headers || existing?.requestHeaders || {},
        responseHeaders: lowerCaseHeaders(event.response.headers || {}),
        firstSeenAt: existing?.firstSeenAt || now,
        lastSeenAt: now,
        playlistCount: existing?.playlistCount || 0,
        segmentCount: existing?.segmentCount || 0,
        endList: existing?.endList || false,
      });
      requestToManifest.set(event.requestId, url);
      if (!existing) {
        console.log(`[manifest] detected ${url}`);
      }
    }

    if (looksLikeSegment(url, mimeType)) {
      const requestScopeId = requests.get(event.requestId)?.scopeId ?? scopeId;
      if (requestScopeId !== scopeId) {
        return;
      }
      recentSegments.unshift({
        url,
        mimeType,
        status: event.response.status,
        seenAt: now,
      });
      if (recentSegments.length > 40) {
        recentSegments.length = 40;
      }
    }
  });

  session.on('Network.loadingFinished', async (event) => {
    const manifestUrl = requestToManifest.get(event.requestId);
    if (!manifestUrl) {
      return;
    }

    try {
      const body = await session.send('Network.getResponseBody', {
        requestId: event.requestId,
      });
      const text = body.base64Encoded
        ? Buffer.from(body.body, 'base64').toString('utf8')
        : body.body;
      const parsed = parseManifest(text);
      const existing = manifests.get(manifestUrl);
      if (existing) {
        manifests.set(manifestUrl, {
          ...existing,
          playlistCount: parsed.playlists?.length || 0,
          segmentCount: parsed.segments?.length || 0,
          endList: Boolean(parsed.endList),
        });
      }
    } catch (error) {
      const existing = manifests.get(manifestUrl);
      if (existing && !existing.parseError) {
        manifests.set(manifestUrl, {
          ...existing,
          parseError: error.message,
        });
      }
    } finally {
      requestToManifest.delete(event.requestId);
    }
  });

  return {
    async enable() {
      if (enabled) {
        return;
      }
      await session.send('Network.enable');
      await session.send('Page.enable');
      enabled = true;
    },
    getSources() {
      return rankSources(manifests.values());
    },
    getRecentSegments() {
      return [...recentSegments];
    },
    reset() {
      scopeId += 1;
      requests.clear();
      requestToManifest.clear();
      manifests.clear();
      recentSegments.length = 0;
    },
  };
}

async function discoverSourcesFromPage(page, tracker, options) {
  await tracker.enable();
  await page.goto(options.url, {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  await page.waitForTimeout(2000);
  await nudgePlayback(page);
  await page.waitForTimeout(options.settleMs);

  return {
    pageTitle: await page.title(),
    videoSources: await getVideoElements(page),
    sources: tracker.getSources(),
  };
}

async function scanCurrentPage(page, tracker, options) {
  await tracker.enable();
  await page.waitForTimeout(500);
  await nudgePlayback(page);
  await page.waitForTimeout(options.settleMs);

  return {
    pageTitle: await page.title().catch(() => '(unknown)'),
    videoSources: await getVideoElements(page),
    sources: tracker.getSources(),
  };
}

function printSources(sources) {
  if (sources.length === 0) {
    console.log('No manifest sources detected yet.');
    return;
  }

  console.log('Detected manifests:');
  for (const [index, source] of sources.entries()) {
    const summary = [
      `segments=${source.segmentCount || 0}`,
      `variants=${source.playlistCount || 0}`,
      `endList=${source.endList ? 'yes' : 'no'}`,
    ].join(' ');
    console.log(`  [${index}] ${summary} ${source.url}`);
  }
}

function printVideos(videos) {
  if (videos.length === 0) {
    console.log('No video elements found on the page.');
    return;
  }

  console.log('Video elements:');
  for (const video of videos) {
    console.log(
      `  [${video.index}] paused=${video.paused} time=${video.currentTime ?? 0}/${video.duration ?? 0} src=${video.currentSrc || video.src || '(empty)'}`,
    );
  }
}

function printButtons(buttons) {
  if (buttons.length === 0) {
    console.log('No buttons found on the page.');
    return;
  }

  console.log('Buttons:');
  for (const button of buttons) {
    console.log(`  [${button.index}] visible=${button.visible} text=${JSON.stringify(button.text)} class=${JSON.stringify(button.className)}`);
  }
}

async function downloadFromManifest(context, manifestUrl, requestHeaders, outputDir, baseName, options, hooks = {}) {
  await fs.promises.mkdir(outputDir, { recursive: true });

  const combinedOutputPath = path.join(outputDir, `${baseName}.ts`);
  const metadataPath = path.join(outputDir, `${baseName}.json`);
  const metadata = {
    requestedAt: new Date().toISOString(),
    manifestUrl,
    manifestsVisited: [],
    segments: [],
    stopRequested: false,
  };

  let activeManifestUrl = manifestUrl;
  let activeHeaders = await buildFetchHeaders(context, activeManifestUrl, requestHeaders, requestHeaders.referer || manifestUrl);

  while (true) {
    if (hooks.shouldStop?.()) {
      metadata.stopRequested = true;
      break;
    }

    const { text } = await fetchText(activeManifestUrl, activeHeaders);
    const parsed = parseManifest(text);
    const manifestEntry = {
      url: activeManifestUrl,
      playlistCount: parsed.playlists?.length || 0,
      segmentCount: parsed.segments?.length || 0,
      endList: Boolean(parsed.endList),
    };
    metadata.manifestsVisited.push(manifestEntry);
    hooks.onManifest?.(manifestEntry);

    if (parsed.playlists?.length) {
      activeManifestUrl = chooseVariant(parsed, activeManifestUrl);
      activeHeaders = await buildFetchHeaders(context, activeManifestUrl, requestHeaders, manifestUrl);
      console.log(`[variant] selected ${activeManifestUrl}`);
      continue;
    }

    const seenUrls = new Set();
    const writtenMapUrls = new Set();
    let emptyPolls = 0;
    let segmentIndex = 0;

    if (fs.existsSync(combinedOutputPath)) {
      await fs.promises.unlink(combinedOutputPath);
    }

    while (true) {
      if (hooks.shouldStop?.()) {
        metadata.stopRequested = true;
        break;
      }

      const { text: mediaPlaylistText } = await fetchText(activeManifestUrl, activeHeaders);
      const media = parseManifest(mediaPlaylistText);
      hooks.onManifest?.({
        url: activeManifestUrl,
        playlistCount: media.playlists?.length || 0,
        segmentCount: media.segments?.length || 0,
        endList: Boolean(media.endList),
      });
      let newSegments = 0;

      for (const segment of media.segments || []) {
        if (hooks.shouldStop?.()) {
          metadata.stopRequested = true;
          break;
        }

        if (segment.map?.uri) {
          const mapUrl = resolveUrl(activeManifestUrl, segment.map.uri);
          if (!writtenMapUrls.has(mapUrl)) {
            const mapHeaders = await buildFetchHeaders(context, mapUrl, requestHeaders, activeManifestUrl);
            const mapResponse = await fetchBuffer(mapUrl, mapHeaders);
            await fs.promises.appendFile(combinedOutputPath, mapResponse.buffer);
            writtenMapUrls.add(mapUrl);
            const mapEntry = {
              index: segmentIndex++,
              url: mapUrl,
              bytes: mapResponse.buffer.length,
              type: 'init-map',
            };
            metadata.segments.push(mapEntry);
            hooks.onSegment?.(mapEntry);
            console.log(`[segment ${segmentIndex}] init map ${mapResponse.buffer.length} bytes`);
          }
        }

        const segmentUrl = resolveUrl(activeManifestUrl, segment.uri);
        if (seenUrls.has(segmentUrl)) {
          continue;
        }

        const segmentHeaders = await buildFetchHeaders(context, segmentUrl, requestHeaders, activeManifestUrl);
        const segmentResponse = await fetchBuffer(segmentUrl, segmentHeaders);
        await fs.promises.appendFile(combinedOutputPath, segmentResponse.buffer);
        seenUrls.add(segmentUrl);
        const segmentEntry = {
          index: segmentIndex++,
          url: segmentUrl,
          bytes: segmentResponse.buffer.length,
          duration: typeof segment.duration === 'number' ? segment.duration : null,
          type: 'media',
        };
        metadata.segments.push(segmentEntry);
        hooks.onSegment?.(segmentEntry);
        newSegments += 1;
        console.log(`[segment ${segmentIndex}] ${segmentResponse.buffer.length} bytes ${segmentUrl}`);
      }

      if (media.endList || metadata.stopRequested) {
        break;
      }

      if (newSegments === 0) {
        emptyPolls += 1;
      } else {
        emptyPolls = 0;
      }

      if (emptyPolls >= options.maxEmptyPolls) {
        console.log('[live] stopping after empty playlist refreshes');
        break;
      }

      const waitMs = Math.max(1, media.targetDuration || options.pollSeconds) * 1000;
      console.log(`[live] waiting ${waitMs}ms for playlist refresh`);
      await sleep(waitMs);
    }

    break;
  }

  metadata.outputPath = combinedOutputPath;
  metadata.totalSegments = metadata.segments.length;
  metadata.totalBytes = metadata.segments.reduce((sum, segment) => sum + segment.bytes, 0);
  await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

  return {
    combinedOutputPath,
    metadataPath,
    totalSegments: metadata.totalSegments,
    totalBytes: metadata.totalBytes,
    stopped: metadata.stopRequested,
  };
}

async function printStatus(page, tracker, recording) {
  const [title, url, videos] = await Promise.all([
    page.title().catch(() => '(unknown)'),
    Promise.resolve(page.url()),
    getVideoElements(page),
  ]);
  console.log(`Page: ${title}`);
  console.log(`URL: ${url}`);
  console.log(`Sources: ${tracker.getSources().length}`);
  if (videos[0]) {
    console.log(`Video[0]: paused=${videos[0].paused} time=${videos[0].currentTime ?? 0}/${videos[0].duration ?? 0}`);
  }

  if (!recording) {
    console.log('Recording: idle');
    return;
  }

  const elapsedSeconds = ((Date.now() - recording.startedAt) / 1000).toFixed(1);
  console.log(`Recording: ${recording.stopRequested ? 'stopping' : 'running'} source=${recording.source.url}`);
  console.log(`Saved: ${recording.segmentCount} segments, ${formatBytes(recording.totalBytes)}, elapsed=${elapsedSeconds}s`);
  if (recording.lastSegment) {
    console.log(`Last segment: ${recording.lastSegment.url}`);
  }
}

function startRecordingTask(context, source, outputDir, baseName, options) {
  const recording = {
    source,
    baseName,
    startedAt: Date.now(),
    stopRequested: false,
    segmentCount: 0,
    totalBytes: 0,
    lastSegment: null,
    result: null,
    error: null,
  };

  recording.promise = downloadFromManifest(
    context,
    source.url,
    source.requestHeaders || {},
    outputDir,
    baseName,
    options,
    {
      shouldStop: () => recording.stopRequested,
      onSegment: (segment) => {
        recording.segmentCount += 1;
        recording.totalBytes += segment.bytes;
        recording.lastSegment = segment;
      },
    },
  ).then((result) => {
    recording.result = result;
    return result;
  }).catch((error) => {
    recording.error = error;
    throw error;
  });

  return recording;
}

async function runInteractiveSession(page, context, tracker, options) {
  await tracker.enable();

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      tracker.reset();
    }
  });

  if (options.url) {
    tracker.reset();
    const discovery = await discoverSourcesFromPage(page, tracker, options);
    console.log(`Loaded: ${discovery.pageTitle}`);
    printSources(discovery.sources);
    printVideos(discovery.videoSources);
    printButtons(await getButtons(page));
  } else {
    await page.goto('about:blank', { waitUntil: 'load' });
    console.log('Browser ready.');
    console.log('Use `open <url>` from the terminal, or type a URL directly in the browser and then run `scan`.');
  }

  console.log('Commands: help, open <url>, scan, videos, buttons, sources, clear, play [n], pause [n], click-button <n>, click <selector>, press <key>, refresh, reload, record [n] [name], stop, status, exit');

  const rl = readline.createInterface({ input, output });
  let recording = null;

  try {
    while (true) {
      const line = (await rl.question('downbrowser> ')).trim();
      if (!line) {
        continue;
      }

      const [command, ...args] = tokenizeCommand(line);

      try {
        if (command === 'help') {
          printHelp();
        } else if (command === 'open' || command === 'goto') {
          if (!args[0]) {
            throw new Error('Usage: open <url>');
          }
          if (recording && !recording.result && !recording.error) {
            throw new Error('Stop the active recording before navigating.');
          }
          tracker.reset();
          await page.goto(args[0], {
            waitUntil: 'domcontentloaded',
            timeout: options.timeoutMs,
          });
          const scan = await scanCurrentPage(page, tracker, options);
          console.log(`Loaded: ${scan.pageTitle}`);
          printSources(scan.sources);
          printVideos(scan.videoSources);
        } else if (command === 'scan') {
          const scan = await scanCurrentPage(page, tracker, options);
          console.log(`Scanned: ${scan.pageTitle}`);
          printSources(scan.sources);
          printVideos(scan.videoSources);
        } else if (command === 'clear') {
          if (recording && !recording.result && !recording.error) {
            throw new Error('Stop the active recording before clearing tracked sources.');
          }
          tracker.reset();
          console.log('Cleared tracked manifests and recent segments.');
        } else if (command === 'videos') {
          printVideos(await getVideoElements(page));
        } else if (command === 'buttons') {
          printButtons(await getButtons(page));
        } else if (command === 'sources') {
          printSources(tracker.getSources());
        } else if (command === 'play') {
          const videoIndex = parseIndex(args[0], 0);
          await page.evaluate((index) => {
            const video = document.querySelectorAll('video')[index];
            if (!video) {
              throw new Error(`Video ${index} not found`);
            }
            video.muted = true;
            return video.play();
          }, videoIndex).catch(async () => {
            await page.locator('video').nth(videoIndex).click({ force: true });
          });
          console.log(`Play requested for video ${videoIndex}`);
        } else if (command === 'pause') {
          const videoIndex = parseIndex(args[0], 0);
          await page.evaluate((index) => {
            const video = document.querySelectorAll('video')[index];
            if (!video) {
              throw new Error(`Video ${index} not found`);
            }
            video.pause();
          }, videoIndex);
          console.log(`Pause requested for video ${videoIndex}`);
        } else if (command === 'click-button') {
          const buttonIndex = parseIndex(args[0]);
          await page.locator('button').nth(buttonIndex).click({ force: true });
          console.log(`Clicked button ${buttonIndex}`);
        } else if (command === 'click') {
          if (!args[0]) {
            throw new Error('Usage: click <selector>');
          }
          await page.locator(args[0]).first().click({ force: true });
          console.log(`Clicked ${args[0]}`);
        } else if (command === 'press') {
          if (!args[0]) {
            throw new Error('Usage: press <key>');
          }
          await page.keyboard.press(args[0]);
          console.log(`Pressed ${args[0]}`);
        } else if (command === 'refresh') {
          await nudgePlayback(page);
          await page.waitForTimeout(2000);
          printSources(tracker.getSources());
          printVideos(await getVideoElements(page));
        } else if (command === 'reload') {
          if (recording && !recording.result && !recording.error) {
            throw new Error('Stop the active recording before reloading.');
          }
          tracker.reset();
          await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: options.timeoutMs,
          });
          const scan = await scanCurrentPage(page, tracker, options);
          console.log(`Reloaded: ${scan.pageTitle}`);
          printSources(scan.sources);
          printVideos(scan.videoSources);
        } else if (command === 'record') {
          if (recording && !recording.result && !recording.error) {
            throw new Error('A recording is already running. Use stop first.');
          }

          const sources = tracker.getSources();
          if (sources.length === 0) {
            throw new Error('No manifest sources detected yet. Use sources or refresh after starting playback.');
          }

          let sourceIndex = 0;
          let nameArg = args.join(' ');
          if (args[0] !== undefined && /^\d+$/.test(args[0])) {
            sourceIndex = parseIndex(args[0], 0);
            nameArg = args.slice(1).join(' ');
          }

          const source = sources[sourceIndex];
          if (!source) {
            throw new Error(`Source ${sourceIndex} not found.`);
          }

          const pageTitle = await page.title().catch(() => 'video');
          const baseName = sanitizeFileName(nameArg || `${pageTitle}-${Date.now()}`);
          recording = startRecordingTask(context, source, options.outputDir, baseName, options);
          console.log(`Recording started from source ${sourceIndex}: ${source.url}`);

          recording.promise.then((result) => {
            console.log(`\n[recording] saved ${result.totalSegments} segment(s), ${formatBytes(result.totalBytes)}`);
            console.log(`[recording] video: ${result.combinedOutputPath}`);
            console.log(`[recording] metadata: ${result.metadataPath}`);
          }).catch((error) => {
            console.error(`\n[recording] failed: ${error.message}`);
          });
        } else if (command === 'stop') {
          if (!recording || recording.result || recording.error) {
            console.log('No active recording.');
            continue;
          }
          recording.stopRequested = true;
          console.log('Stop requested. Waiting for current segment to finish...');
        } else if (command === 'status') {
          await printStatus(page, tracker, recording && !recording.result && !recording.error ? recording : recording);
        } else if (command === 'exit' || command === 'quit') {
          if (recording && !recording.result && !recording.error) {
            recording.stopRequested = true;
            console.log('Stopping active recording before exit...');
            await recording.promise.catch(() => {});
          }
          break;
        } else {
          console.log(`Unknown command: ${command}`);
        }
      } catch (error) {
        console.error(error.message);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.interactive && !options.url && !options.manifestUrl)) {
    printHelp();
    return;
  }

  const browser = await chromium.launch({
    headless: options.headless,
  });

  const context = await browser.newContext({
    acceptDownloads: false,
  });

  try {
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const tracker = createNetworkTracker(session);

    if (options.interactive) {
      await runInteractiveSession(page, context, tracker, options);
      return;
    }

    let manifestUrl = options.manifestUrl;
    let requestHeaders = {};
    let pageTitle = options.name || 'video';
    let videoSources = [];

    if (options.url) {
      const discovery = await discoverSourcesFromPage(page, tracker, options);
      pageTitle = discovery.pageTitle || pageTitle;
      videoSources = discovery.videoSources || [];
      const selectedSource = discovery.sources[0];

      if (!selectedSource) {
        throw new Error(`No HLS manifest detected on ${options.url}. Video elements seen: ${JSON.stringify(videoSources)}`);
      }

      manifestUrl = selectedSource.url;
      requestHeaders = selectedSource.requestHeaders || {};
      console.log(`[manifest] selected ${manifestUrl}`);
    }

    const baseName = sanitizeFileName(options.name || pageTitle || new URL(manifestUrl).hostname);
    const result = await downloadFromManifest(
      context,
      manifestUrl,
      requestHeaders,
      options.outputDir,
      baseName,
      options,
    );

    console.log(`Saved ${result.totalSegments} segment(s), ${result.totalBytes} bytes`);
    console.log(`Video: ${result.combinedOutputPath}`);
    console.log(`Metadata: ${result.metadataPath}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

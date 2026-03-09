const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { Parser } = require('m3u8-parser');

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

function formatTimestamp(value) {
  if (!value) {
    return 'never';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
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

async function cookieHeaderFor(context, url) {
  const cookies = await context.cookies(url);
  if (cookies.length === 0) {
    return '';
  }
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function buildFetchHeaders(context, url, requestHeaders, referer) {
  const headers = { accept: '*/*' };
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
  return Buffer.from(arrayBuffer);
}

async function fetchText(url, headers) {
  const buffer = await fetchBuffer(url, headers);
  return buffer.toString('utf8');
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

function createNetworkTracker(session, onLog) {
  const requests = new Map();
  const requestToManifest = new Map();
  const manifests = new Map();
  const recentSegments = [];
  let scopeId = 0;
  let lastResetAt = new Date().toISOString();
  let lastScanAt = null;
  let lastScanScopeId = null;
  let lastScanPageUrl = null;
  let lastScanPageTitle = null;
  let lastScanSourceCount = 0;
  let lastScanVideoCount = 0;
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
      if (!existing && onLog) {
        onLog('info', `[manifest] detected ${url}`);
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
      const body = await session.send('Network.getResponseBody', { requestId: event.requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
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
        manifests.set(manifestUrl, { ...existing, parseError: error.message });
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
    getScopeId() {
      return scopeId;
    },
    getMeta() {
      return {
        scopeId,
        lastResetAt,
        lastScanAt,
        lastScanScopeId,
        lastScanPageUrl,
        lastScanPageTitle,
        lastScanSourceCount,
        lastScanVideoCount,
      };
    },
    markScan(details = {}) {
      lastScanAt = new Date().toISOString();
      lastScanScopeId = scopeId;
      lastScanPageUrl = details.pageUrl || null;
      lastScanPageTitle = details.pageTitle || null;
      lastScanSourceCount = details.sourceCount || 0;
      lastScanVideoCount = details.videoCount || 0;
    },
    reset() {
      scopeId += 1;
      lastResetAt = new Date().toISOString();
      requests.clear();
      requestToManifest.clear();
      manifests.clear();
      recentSegments.length = 0;
    },
  };
}

function getSourceFreshness(tracker) {
  const meta = tracker.getMeta();
  const currentScopeId = tracker.getScopeId();
  return {
    isFresh: meta.lastScanScopeId === currentScopeId,
    lastScanAt: meta.lastScanAt,
    lastScanPageUrl: meta.lastScanPageUrl,
    lastScanPageTitle: meta.lastScanPageTitle,
    lastScanSourceCount: meta.lastScanSourceCount,
    lastScanVideoCount: meta.lastScanVideoCount,
    lastResetAt: meta.lastResetAt,
    scopeId: currentScopeId,
  };
}

async function refreshTabSnapshot(tabState) {
  tabState.lastKnownTitle = await tabState.page.title().catch(() => '(unknown)');
  tabState.lastKnownUrl = tabState.page.url();
}

async function scanCurrentPage(page, tracker, options) {
  await tracker.enable();
  await page.waitForTimeout(500);
  await nudgePlayback(page);
  await page.waitForTimeout(options.settleMs);

  const scan = {
    pageTitle: await page.title().catch(() => '(unknown)'),
    videoSources: await getVideoElements(page),
    buttons: await getButtons(page),
    sources: tracker.getSources(),
  };
  tracker.markScan({
    pageUrl: page.url(),
    pageTitle: scan.pageTitle,
    sourceCount: scan.sources.length,
    videoCount: scan.videoSources.length,
  });
  return scan;
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

    const text = await fetchText(activeManifestUrl, activeHeaders);
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
      hooks.onLog?.('info', `[variant] selected ${activeManifestUrl}`);
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

      const mediaPlaylistText = await fetchText(activeManifestUrl, activeHeaders);
      const media = parseManifest(mediaPlaylistText);
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
            const mapBuffer = await fetchBuffer(mapUrl, mapHeaders);
            await fs.promises.appendFile(combinedOutputPath, mapBuffer);
            writtenMapUrls.add(mapUrl);
            const mapEntry = { index: segmentIndex++, url: mapUrl, bytes: mapBuffer.length, type: 'init-map' };
            metadata.segments.push(mapEntry);
            hooks.onSegment?.(mapEntry);
          }
        }

        const segmentUrl = resolveUrl(activeManifestUrl, segment.uri);
        if (seenUrls.has(segmentUrl)) {
          continue;
        }

        const segmentHeaders = await buildFetchHeaders(context, segmentUrl, requestHeaders, activeManifestUrl);
        const segmentBuffer = await fetchBuffer(segmentUrl, segmentHeaders);
        await fs.promises.appendFile(combinedOutputPath, segmentBuffer);
        seenUrls.add(segmentUrl);
        const segmentEntry = {
          index: segmentIndex++,
          url: segmentUrl,
          bytes: segmentBuffer.length,
          duration: typeof segment.duration === 'number' ? segment.duration : null,
          type: 'media',
        };
        metadata.segments.push(segmentEntry);
        hooks.onSegment?.(segmentEntry);
        newSegments += 1;
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
        hooks.onLog?.('info', '[live] stopping after empty playlist refreshes');
        break;
      }

      const waitMs = Math.max(1, media.targetDuration || options.pollSeconds) * 1000;
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

class DownBrowserGuiCore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      outputDir: path.resolve(process.cwd(), 'downloads'),
      headless: false,
      timeoutMs: 45000,
      pollSeconds: 4,
      maxEmptyPolls: 3,
      settleMs: 4000,
      ...options,
    };
    this.browser = null;
    this.context = null;
    this.tabStateMap = new Map();
    this.currentTabId = null;
    this.nextTabId = 1;
    this.recording = null;
    this.logs = [];
    this.stateTimer = null;
  }

  log(level, message) {
    const entry = { id: Date.now() + Math.random(), level, message, at: new Date().toISOString() };
    this.logs.push(entry);
    if (this.logs.length > 300) {
      this.logs.shift();
    }
    this.emit('log', entry);
    this.scheduleStateEmit();
  }

  scheduleStateEmit() {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(async () => {
      this.stateTimer = null;
      this.emit('state', await this.getState());
    }, 80);
  }

  async start() {
    this.browser = await chromium.launch({ headless: this.options.headless });
    this.context = await this.browser.newContext({ acceptDownloads: false });
    const tab = await this.createTab();
    this.currentTabId = tab.id;
    await tab.page.bringToFront().catch(() => {});
    this.log('info', 'GUI session started');
    this.scheduleStateEmit();
    return this.getState();
  }

  async createTab() {
    const page = await this.context.newPage();
    const session = await this.context.newCDPSession(page);
    const tracker = createNetworkTracker(session, (level, message) => this.log(level, message));
    await tracker.enable();

    const tab = {
      id: this.nextTabId++,
      page,
      session,
      tracker,
      lastKnownTitle: '(untitled)',
      lastKnownUrl: 'about:blank',
      closed: false,
    };

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        tracker.reset();
        tab.lastKnownUrl = page.url();
        this.scheduleStateEmit();
      }
    });

    page.on('close', () => {
      tab.closed = true;
      this.tabStateMap.delete(tab.id);
      if (this.currentTabId === tab.id) {
        const nextId = [...this.tabStateMap.keys()].sort((a, b) => a - b)[0] || null;
        this.currentTabId = nextId;
      }
      this.scheduleStateEmit();
    });

    await page.goto('about:blank', { waitUntil: 'load' });
    await refreshTabSnapshot(tab);
    this.tabStateMap.set(tab.id, tab);
    return tab;
  }

  getCurrentTab() {
    const tab = this.tabStateMap.get(this.currentTabId);
    if (!tab) {
      throw new Error('No active tab');
    }
    return tab;
  }

  async getTabDetails(tab) {
    if (!tab || tab.closed) {
      return null;
    }
    const [title, url, videos, buttons] = await Promise.all([
      tab.page.title().catch(() => '(unknown)'),
      Promise.resolve(tab.page.url()),
      getVideoElements(tab.page),
      getButtons(tab.page),
    ]);
    tab.lastKnownTitle = title;
    tab.lastKnownUrl = url;
    const freshness = getSourceFreshness(tab.tracker);
    return {
      id: tab.id,
      title,
      url,
      sources: tab.tracker.getSources(),
      recentSegments: tab.tracker.getRecentSegments(),
      videos,
      buttons,
      freshness: {
        ...freshness,
        lastResetDisplay: formatTimestamp(freshness.lastResetAt),
        lastScanDisplay: formatTimestamp(freshness.lastScanAt),
      },
    };
  }

  async getState() {
    const tabs = [];
    for (const tab of [...this.tabStateMap.values()].sort((a, b) => a.id - b.id)) {
      if (tab.closed) {
        continue;
      }
      await refreshTabSnapshot(tab);
      tabs.push({
        id: tab.id,
        title: tab.lastKnownTitle,
        url: tab.lastKnownUrl,
        sourcesCount: tab.tracker.getSources().length,
        freshness: getSourceFreshness(tab.tracker).isFresh,
      });
    }

    const currentTab = this.currentTabId ? await this.getTabDetails(this.getCurrentTab()) : null;
    return {
      options: this.options,
      currentTabId: this.currentTabId,
      tabs,
      currentTab,
      recording: this.recording ? {
        tabId: this.recording.tabId,
        source: this.recording.source,
        baseName: this.recording.baseName,
        startedAt: this.recording.startedAt,
        elapsedMs: Date.now() - this.recording.startedAt,
        stopRequested: this.recording.stopRequested,
        segmentCount: this.recording.segmentCount,
        expectedSegments: this.recording.expectedSegments,
        totalBytes: this.recording.totalBytes,
        totalBytesDisplay: formatBytes(this.recording.totalBytes),
        avgSegmentBytes: this.recording.segmentCount ? Math.round(this.recording.totalBytes / this.recording.segmentCount) : 0,
        avgSegmentBytesDisplay: formatBytes(this.recording.segmentCount ? Math.round(this.recording.totalBytes / this.recording.segmentCount) : 0),
        throughputBytesPerSecond: this.recording.throughputBytesPerSecond || 0,
        throughputBytesPerSecondDisplay: formatBytes(this.recording.throughputBytesPerSecond || 0),
        segmentsPerSecond: this.recording.segmentsPerSecond || 0,
        estimatedRemainingMs: this.recording.estimatedRemainingMs || null,
        lastSegment: this.recording.lastSegment,
        result: this.recording.result,
        error: this.recording.error ? this.recording.error.message : null,
      } : null,
      logs: this.logs.slice(-120),
    };
  }

  async newTab() {
    const tab = await this.createTab();
    this.currentTabId = tab.id;
    await tab.page.bringToFront().catch(() => {});
    this.log('info', `Created tab ${tab.id}`);
    return this.getState();
  }

  async useTab(tabId) {
    const tab = this.tabStateMap.get(Number(tabId));
    if (!tab || tab.closed) {
      throw new Error(`Tab ${tabId} not found`);
    }
    this.currentTabId = tab.id;
    await tab.page.bringToFront().catch(() => {});
    this.log('info', `Switched to tab ${tab.id}`);
    return this.getState();
  }

  async closeTab(tabId) {
    const targetId = Number(tabId || this.currentTabId);
    const tab = this.tabStateMap.get(targetId);
    if (!tab || tab.closed) {
      throw new Error(`Tab ${targetId} not found`);
    }
    if (this.tabStateMap.size === 1) {
      throw new Error('Cannot close the last tab');
    }
    if (this.recording && !this.recording.result && !this.recording.error && this.recording.tabId === targetId) {
      throw new Error('Stop the active recording before closing its tab');
    }
    await tab.page.close();
    this.log('info', `Closed tab ${targetId}`);
    return this.getState();
  }

  async openUrl(url) {
    const tab = this.getCurrentTab();
    if (this.recording && !this.recording.result && !this.recording.error && this.recording.tabId === tab.id) {
      throw new Error('Stop the active recording in this tab before navigating');
    }
    tab.tracker.reset();
    await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
    const scan = await scanCurrentPage(tab.page, tab.tracker, this.options);
    tab.lastKnownTitle = scan.pageTitle;
    tab.lastKnownUrl = tab.page.url();
    this.log('info', `Loaded ${scan.pageTitle}`);
    return this.getState();
  }

  async scan() {
    const tab = this.getCurrentTab();
    const scan = await scanCurrentPage(tab.page, tab.tracker, this.options);
    tab.lastKnownTitle = scan.pageTitle;
    tab.lastKnownUrl = tab.page.url();
    this.log('info', `Scanned ${scan.pageTitle}`);
    return this.getState();
  }

  async reload() {
    const tab = this.getCurrentTab();
    if (this.recording && !this.recording.result && !this.recording.error && this.recording.tabId === tab.id) {
      throw new Error('Stop the active recording in this tab before reloading');
    }
    tab.tracker.reset();
    await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
    const scan = await scanCurrentPage(tab.page, tab.tracker, this.options);
    tab.lastKnownTitle = scan.pageTitle;
    tab.lastKnownUrl = tab.page.url();
    this.log('info', `Reloaded ${scan.pageTitle}`);
    return this.getState();
  }

  async clearSources() {
    const tab = this.getCurrentTab();
    if (this.recording && !this.recording.result && !this.recording.error && this.recording.tabId === tab.id) {
      throw new Error('Stop the active recording in this tab before clearing tracked sources');
    }
    tab.tracker.reset();
    this.log('info', `Cleared tracked sources for tab ${tab.id}`);
    return this.getState();
  }

  async refresh() {
    const tab = this.getCurrentTab();
    await nudgePlayback(tab.page);
    await tab.page.waitForTimeout(2000);
    this.log('info', `Refreshed tab ${tab.id}`);
    return this.getState();
  }

  async playVideo(index = 0) {
    const tab = this.getCurrentTab();
    await tab.page.evaluate((videoIndex) => {
      const video = document.querySelectorAll('video')[videoIndex];
      if (!video) {
        throw new Error(`Video ${videoIndex} not found`);
      }
      video.muted = true;
      return video.play();
    }, Number(index)).catch(async () => {
      await tab.page.locator('video').nth(Number(index)).click({ force: true });
    });
    this.log('info', `Play requested for video ${index}`);
    return this.getState();
  }

  async pauseVideo(index = 0) {
    const tab = this.getCurrentTab();
    await tab.page.evaluate((videoIndex) => {
      const video = document.querySelectorAll('video')[videoIndex];
      if (!video) {
        throw new Error(`Video ${videoIndex} not found`);
      }
      video.pause();
    }, Number(index));
    this.log('info', `Pause requested for video ${index}`);
    return this.getState();
  }

  async clickButton(index) {
    const tab = this.getCurrentTab();
    await tab.page.locator('button').nth(Number(index)).click({ force: true });
    this.log('info', `Clicked button ${index}`);
    return this.getState();
  }

  async clickSelector(selector) {
    const tab = this.getCurrentTab();
    await tab.page.locator(selector).first().click({ force: true });
    this.log('info', `Clicked ${selector}`);
    return this.getState();
  }

  async pressKey(key) {
    const tab = this.getCurrentTab();
    await tab.page.keyboard.press(key);
    this.log('info', `Pressed ${key}`);
    return this.getState();
  }

  async startRecording(sourceIndex = 0, name = '') {
    if (this.recording && !this.recording.result && !this.recording.error) {
      throw new Error('A recording is already running');
    }

    const tab = this.getCurrentTab();
    const freshness = getSourceFreshness(tab.tracker);
    if (!freshness.isFresh) {
      throw new Error('Tracked sources are stale for this page. Run scan or reload first.');
    }

    const sources = tab.tracker.getSources();
    if (!sources.length) {
      throw new Error('No manifest sources detected yet');
    }

    const source = sources[Number(sourceIndex)];
    if (!source) {
      throw new Error(`Source ${sourceIndex} not found`);
    }

    const pageTitle = await tab.page.title().catch(() => 'video');
    const baseName = sanitizeFileName(name || `${pageTitle}-${Date.now()}`);
    this.recording = {
      tabId: tab.id,
      source,
      baseName,
      startedAt: Date.now(),
      stopRequested: false,
      segmentCount: 0,
      totalBytes: 0,
      lastSegment: null,
      result: null,
      error: null,
      expectedSegments: source.segmentCount || null,
      throughputBytesPerSecond: 0,
      segmentsPerSecond: 0,
    };

    this.log('info', `Recording started from tab ${tab.id}, source ${sourceIndex}: ${source.url}`);
    this.recording.promise = downloadFromManifest(
      this.context,
      source.url,
      source.requestHeaders || {},
      this.options.outputDir,
      baseName,
      this.options,
      {
        shouldStop: () => this.recording && this.recording.stopRequested,
        onSegment: (segment) => {
          if (!this.recording) {
            return;
          }
          this.recording.segmentCount += 1;
          this.recording.totalBytes += segment.bytes;
          this.recording.lastSegment = segment;
          const elapsedMs = Math.max(1, Date.now() - this.recording.startedAt);
          this.recording.throughputBytesPerSecond = Math.round((this.recording.totalBytes / elapsedMs) * 1000);
          this.recording.segmentsPerSecond = Number(((this.recording.segmentCount / elapsedMs) * 1000).toFixed(2));
          if (this.recording.expectedSegments && this.recording.segmentCount > 0) {
            const avgMsPerSegment = elapsedMs / this.recording.segmentCount;
            const remainingSegments = Math.max(0, this.recording.expectedSegments - this.recording.segmentCount);
            this.recording.estimatedRemainingMs = Math.round(avgMsPerSegment * remainingSegments);
          }
          this.scheduleStateEmit();
        },
        onLog: (level, message) => this.log(level, message),
      },
    ).then((result) => {
      if (!this.recording) {
        return result;
      }
      this.recording.result = result;
      this.log('info', `Recording saved: ${result.combinedOutputPath}`);
      this.scheduleStateEmit();
      return result;
    }).catch((error) => {
      if (this.recording) {
        this.recording.error = error;
      }
      this.log('error', `Recording failed: ${error.message}`);
      this.scheduleStateEmit();
      throw error;
    });

    return this.getState();
  }

  async stopRecording() {
    if (!this.recording || this.recording.result || this.recording.error) {
      throw new Error('No active recording');
    }
    this.recording.stopRequested = true;
    this.log('info', `Stop requested for tab ${this.recording.tabId}`);
    this.scheduleStateEmit();
    return this.getState();
  }

  async dispose() {
    clearTimeout(this.stateTimer);
    if (this.recording && !this.recording.result && !this.recording.error) {
      this.recording.stopRequested = true;
      await this.recording.promise.catch(() => {});
    }
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

module.exports = {
  DownBrowserGuiCore,
  formatBytes,
  formatTimestamp,
};

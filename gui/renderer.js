const state = {
  data: null,
};

const els = {
  tabList: document.getElementById('tab-list'),
  urlInput: document.getElementById('url-input'),
  openBtn: document.getElementById('open-btn'),
  newTabBtn: document.getElementById('new-tab-btn'),
  scanBtn: document.getElementById('scan-btn'),
  reloadBtn: document.getElementById('reload-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  clearBtn: document.getElementById('clear-btn'),
  chooseOutputBtn: document.getElementById('choose-output-btn'),
  outputDir: document.getElementById('output-dir'),
  recordName: document.getElementById('record-name'),
  stopBtn: document.getElementById('stop-btn'),
  playBtn: document.getElementById('play-btn'),
  pauseBtn: document.getElementById('pause-btn'),
  selectorInput: document.getElementById('selector-input'),
  clickSelectorBtn: document.getElementById('click-selector-btn'),
  keyInput: document.getElementById('key-input'),
  pressKeyBtn: document.getElementById('press-key-btn'),
  pageTitle: document.getElementById('page-title'),
  pageUrl: document.getElementById('page-url'),
  freshnessText: document.getElementById('freshness-text'),
  scopeText: document.getElementById('scope-text'),
  recordingText: document.getElementById('recording-text'),
  sourcesList: document.getElementById('sources-list'),
  videosList: document.getElementById('videos-list'),
  buttonsList: document.getElementById('buttons-list'),
  segmentsList: document.getElementById('segments-list'),
  recordingPanel: document.getElementById('recording-panel'),
  logList: document.getElementById('log-list'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function act(action, payload) {
  try {
    await window.downbrowser.act(action, payload);
  } catch (error) {
    appendLocalError(error.message || String(error));
  }
}

function appendLocalError(message) {
  const current = state.data || { logs: [] };
  current.logs = current.logs || [];
  current.logs.push({ id: Date.now(), level: 'error', message, at: new Date().toISOString() });
  renderLogs(current.logs);
}

function renderTabs(data) {
  els.tabList.innerHTML = data.tabs.map((tab) => {
    const active = tab.id === data.currentTabId;
    return `
      <div class="tab-card ${active ? 'active' : ''}">
        <div class="tab-title">Tab ${tab.id}</div>
        <div class="list-meta">${escapeHtml(tab.title)}</div>
        <div class="list-meta">${escapeHtml(tab.url)}</div>
        <div class="pill-row">
          <span class="pill">sources ${tab.sourcesCount}</span>
          <span class="pill ${tab.freshness ? '' : 'warn'}">fresh ${tab.freshness ? 'yes' : 'no'}</span>
        </div>
        <div class="item-actions">
          <button data-action="use-tab" data-tab-id="${tab.id}">${active ? 'Active' : 'Use'}</button>
          <button class="ghost" data-action="close-tab" data-tab-id="${tab.id}">Close</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderSources(currentTab) {
  if (!currentTab || !currentTab.sources.length) {
    els.sourcesList.innerHTML = '<div class="list-item"><div class="list-title">No manifest sources detected</div><div class="list-meta">Run scan, play the video, or reload the page.</div></div>';
    return;
  }

  els.sourcesList.innerHTML = currentTab.sources.map((source, index) => `
    <div class="list-item">
      <div class="list-title">Source ${index}</div>
      <div class="pill-row">
        <span class="pill">segments ${source.segmentCount || 0}</span>
        <span class="pill gold">variants ${source.playlistCount || 0}</span>
        <span class="pill ${source.endList ? '' : 'warn'}">endList ${source.endList ? 'yes' : 'no'}</span>
      </div>
      <div class="list-meta">${escapeHtml(source.url)}</div>
      <div class="item-actions">
        <button data-action="record-source" data-source-index="${index}">Record</button>
      </div>
    </div>
  `).join('');
}

function renderVideos(currentTab) {
  if (!currentTab || !currentTab.videos.length) {
    els.videosList.innerHTML = '<div class="list-item"><div class="list-title">No video elements</div></div>';
    return;
  }

  els.videosList.innerHTML = currentTab.videos.map((video) => `
    <div class="list-item">
      <div class="list-title">Video ${video.index}</div>
      <div class="pill-row">
        <span class="pill">paused ${video.paused}</span>
        <span class="pill gold">time ${video.currentTime ?? 0}/${video.duration ?? 0}</span>
      </div>
      <div class="list-meta">${escapeHtml(video.currentSrc || video.src || '(empty)')}</div>
      <div class="item-actions">
        <button data-action="play-video" data-index="${video.index}">Play</button>
        <button class="ghost" data-action="pause-video" data-index="${video.index}">Pause</button>
      </div>
    </div>
  `).join('');
}

function renderButtons(currentTab) {
  if (!currentTab || !currentTab.buttons.length) {
    els.buttonsList.innerHTML = '<div class="list-item"><div class="list-title">No buttons found</div></div>';
    return;
  }

  els.buttonsList.innerHTML = currentTab.buttons.map((button) => `
    <div class="list-item">
      <div class="list-title">Button ${button.index}</div>
      <div class="pill-row">
        <span class="pill ${button.visible ? '' : 'warn'}">visible ${button.visible}</span>
      </div>
      <div class="list-meta">${escapeHtml(button.text || '(no text)')}</div>
      <div class="list-meta">class: ${escapeHtml(button.className || '(none)')}</div>
      <div class="item-actions">
        <button data-action="click-button" data-index="${button.index}">Click</button>
      </div>
    </div>
  `).join('');
}

function renderSegments(currentTab) {
  if (!currentTab || !currentTab.recentSegments.length) {
    els.segmentsList.innerHTML = '<div class="list-item"><div class="list-title">No recent segments</div></div>';
    return;
  }

  els.segmentsList.innerHTML = currentTab.recentSegments.slice(0, 20).map((segment) => `
    <div class="list-item">
      <div class="list-title">${escapeHtml(segment.status)} ${escapeHtml(segment.mimeType || 'media')}</div>
      <div class="list-meta">${escapeHtml(segment.url)}</div>
      <div class="list-meta">${escapeHtml(segment.seenAt)}</div>
    </div>
  `).join('');
}

function renderRecording(data) {
  if (!data.recording) {
    els.recordingPanel.innerHTML = '<div class="recording-card"><div class="list-title">No active recording</div><div class="list-meta">Choose a source and start recording from the current tab.</div></div>';
    return;
  }

  const recording = data.recording;
  els.recordingPanel.innerHTML = `
    <div class="recording-card">
      <div class="list-title">Recording tab ${recording.tabId}</div>
      <div class="pill-row">
        <span class="pill ${recording.stopRequested ? 'warn' : ''}">${recording.stopRequested ? 'stopping' : 'running'}</span>
        <span class="pill gold">segments ${recording.segmentCount}</span>
        <span class="pill">bytes ${recording.totalBytesDisplay}</span>
      </div>
      <div class="recording-grid">
        <div class="recording-metric">
          <div class="eyebrow">Base Name</div>
          <strong>${escapeHtml(recording.baseName)}</strong>
        </div>
        <div class="recording-metric">
          <div class="eyebrow">Started</div>
          <strong>${escapeHtml(new Date(recording.startedAt).toLocaleString())}</strong>
        </div>
      </div>
      <div class="list-meta">${escapeHtml(recording.source.url)}</div>
      ${recording.result ? `<div class="list-meta">saved: ${escapeHtml(recording.result.combinedOutputPath)}</div>` : ''}
      ${recording.error ? `<div class="list-meta">error: ${escapeHtml(recording.error)}</div>` : ''}
    </div>
  `;
}

function renderLogs(logs) {
  els.logList.innerHTML = logs.slice(-80).reverse().map((entry) => `
    <div class="log-item ${escapeHtml(entry.level)}">
      <div class="list-title">${escapeHtml(entry.level.toUpperCase())}</div>
      <div class="log-meta">${escapeHtml(new Date(entry.at).toLocaleTimeString())}</div>
      <div class="list-meta">${escapeHtml(entry.message)}</div>
    </div>
  `).join('');
}

function renderState(data) {
  state.data = data;
  const currentTab = data.currentTab;
  els.outputDir.value = data.options.outputDir;
  els.pageTitle.textContent = currentTab ? currentTab.title : 'No active tab';
  els.pageUrl.textContent = currentTab ? currentTab.url : '';
  els.freshnessText.textContent = currentTab ? (currentTab.freshness.isFresh ? 'Fresh' : 'Stale') : 'Unknown';
  els.scopeText.textContent = currentTab ? `${currentTab.freshness.scopeId}` : '-';
  els.recordingText.textContent = data.recording ? `${data.recording.stopRequested ? 'Stopping' : 'Running'} (tab ${data.recording.tabId})` : 'Idle';
  renderTabs(data);
  renderSources(currentTab);
  renderVideos(currentTab);
  renderButtons(currentTab);
  renderSegments(currentTab);
  renderRecording(data);
  renderLogs(data.logs || []);
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  if (action === 'use-tab') {
    await act('use-tab', { tabId: Number(target.dataset.tabId) });
  } else if (action === 'close-tab') {
    await act('close-tab', { tabId: Number(target.dataset.tabId) });
  } else if (action === 'record-source') {
    await act('start-recording', { sourceIndex: Number(target.dataset.sourceIndex), name: els.recordName.value.trim() });
  } else if (action === 'play-video') {
    await act('play-video', { index: Number(target.dataset.index) });
  } else if (action === 'pause-video') {
    await act('pause-video', { index: Number(target.dataset.index) });
  } else if (action === 'click-button') {
    await act('click-button', { index: Number(target.dataset.index) });
  }
});

els.newTabBtn.addEventListener('click', () => act('new-tab'));
els.openBtn.addEventListener('click', () => act('open-url', { url: els.urlInput.value.trim() }));
els.scanBtn.addEventListener('click', () => act('scan'));
els.reloadBtn.addEventListener('click', () => act('reload'));
els.refreshBtn.addEventListener('click', () => act('refresh'));
els.clearBtn.addEventListener('click', () => act('clear-sources'));
els.stopBtn.addEventListener('click', () => act('stop-recording'));
els.playBtn.addEventListener('click', () => act('play-video', { index: 0 }));
els.pauseBtn.addEventListener('click', () => act('pause-video', { index: 0 }));
els.clickSelectorBtn.addEventListener('click', () => act('click-selector', { selector: els.selectorInput.value.trim() }));
els.pressKeyBtn.addEventListener('click', () => act('press-key', { key: els.keyInput.value.trim() }));
els.chooseOutputBtn.addEventListener('click', async () => {
  try {
    await window.downbrowser.pickOutputDir();
  } catch (error) {
    appendLocalError(error.message || String(error));
  }
});

window.downbrowser.onState(renderState);
window.downbrowser.onLog(() => {});

(async () => {
  try {
    const initial = await window.downbrowser.getState();
    renderState(initial);
  } catch (error) {
    appendLocalError(error.message || String(error));
  }
})();

const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const { DownBrowserGuiCore } = require('./lib/downbrowser-gui-core');

let mainWindow = null;
let core = null;
let lastRecordingNoticeKey = null;

function maybeNotifyRecording(state) {
  const recording = state?.recording;
  if (!recording) {
    lastRecordingNoticeKey = null;
    return;
  }

  if (recording.result?.combinedOutputPath) {
    const key = `done:${recording.result.combinedOutputPath}`;
    if (lastRecordingNoticeKey === key) {
      return;
    }
    lastRecordingNoticeKey = key;
    if (Notification.isSupported()) {
      new Notification({
        title: 'DownBrowser Recording Complete',
        body: recording.result.combinedOutputPath,
      }).show();
    }
    return;
  }

  if (recording.error) {
    const key = `error:${recording.baseName}:${recording.error}`;
    if (lastRecordingNoticeKey === key) {
      return;
    }
    lastRecordingNoticeKey = key;
    if (Notification.isSupported()) {
      new Notification({
        title: 'DownBrowser Recording Failed',
        body: recording.error,
      }).show();
    }
    return;
  }

  lastRecordingNoticeKey = null;
}

function sendState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('downbrowser:state', state);
  }
  maybeNotifyRecording(state);
}

function sendLog(entry) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('downbrowser:log', entry);
  }
}

async function createMainWindow() {
  core = new DownBrowserGuiCore({
    headless: false,
    outputDir: path.resolve(process.cwd(), 'downloads'),
  });

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: '#ebe5d6',
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  core.on('state', sendState);
  core.on('log', sendLog);

  await mainWindow.loadFile(path.join(__dirname, 'gui', 'index.html'));
  const state = await core.start();
  sendState(state);

  mainWindow.on('closed', async () => {
    mainWindow = null;
    await core?.dispose();
    core = null;
  });
}

function ensureCore() {
  if (!core) {
    throw new Error('GUI core is not ready');
  }
  return core;
}

ipcMain.handle('downbrowser:get-state', async () => ensureCore().getState());

ipcMain.handle('downbrowser:pick-output-dir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  ensureCore().options.outputDir = result.filePaths[0];
  const state = await ensureCore().getState();
  sendState(state);
  return result.filePaths[0];
});

ipcMain.handle('downbrowser:set-auto-remux', async (_event, enabled) => {
  ensureCore().setAutoRemux(enabled);
  const state = await ensureCore().getState();
  sendState(state);
  return state;
});

ipcMain.handle('downbrowser:action', async (_event, action, payload = {}) => {
  try {
    const guiCore = ensureCore();
    let state;
    switch (action) {
      case 'new-tab':
        state = await guiCore.newTab();
        break;
      case 'use-tab':
        state = await guiCore.useTab(payload.tabId);
        break;
      case 'close-tab':
        state = await guiCore.closeTab(payload.tabId);
        break;
      case 'open-url':
        state = await guiCore.openUrl(payload.url);
        break;
      case 'scan':
        state = await guiCore.scan();
        break;
      case 'reload':
        state = await guiCore.reload();
        break;
      case 'refresh':
        state = await guiCore.refresh();
        break;
      case 'clear-sources':
        state = await guiCore.clearSources();
        break;
      case 'play-video':
        state = await guiCore.playVideo(payload.index);
        break;
      case 'pause-video':
        state = await guiCore.pauseVideo(payload.index);
        break;
      case 'click-button':
        state = await guiCore.clickButton(payload.index);
        break;
      case 'click-selector':
        state = await guiCore.clickSelector(payload.selector);
        break;
      case 'press-key':
        state = await guiCore.pressKey(payload.key);
        break;
      case 'start-recording':
        state = await guiCore.startRecording(payload.sourceIndex, payload.name);
        break;
      case 'queue-recording':
        state = await guiCore.enqueueRecording(payload.sourceIndex, payload.name);
        break;
      case 'stop-recording':
        state = await guiCore.stopRecording();
        break;
      case 'open-path': {
        const targetPath = payload.path;
        if (!targetPath) {
          throw new Error('No path provided');
        }
        shell.showItemInFolder(targetPath);
        state = await guiCore.getState();
        break;
      }
      case 'open-file': {
        const targetPath = payload.path;
        if (!targetPath) {
          throw new Error('No path provided');
        }
        const opened = await shell.openPath(targetPath);
        if (opened) {
          throw new Error(opened);
        }
        state = await guiCore.getState();
        break;
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    return { ok: true, state };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
    };
  }
});

app.whenReady().then(async () => {
  await createMainWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

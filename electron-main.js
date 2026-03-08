const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { DownBrowserGuiCore } = require('./lib/downbrowser-gui-core');

let mainWindow = null;
let core = null;

function sendState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('downbrowser:state', state);
  }
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

ipcMain.handle('downbrowser:action', async (_event, action, payload = {}) => {
  const guiCore = ensureCore();
  switch (action) {
    case 'new-tab':
      return guiCore.newTab();
    case 'use-tab':
      return guiCore.useTab(payload.tabId);
    case 'close-tab':
      return guiCore.closeTab(payload.tabId);
    case 'open-url':
      return guiCore.openUrl(payload.url);
    case 'scan':
      return guiCore.scan();
    case 'reload':
      return guiCore.reload();
    case 'refresh':
      return guiCore.refresh();
    case 'clear-sources':
      return guiCore.clearSources();
    case 'play-video':
      return guiCore.playVideo(payload.index);
    case 'pause-video':
      return guiCore.pauseVideo(payload.index);
    case 'click-button':
      return guiCore.clickButton(payload.index);
    case 'click-selector':
      return guiCore.clickSelector(payload.selector);
    case 'press-key':
      return guiCore.pressKey(payload.key);
    case 'start-recording':
      return guiCore.startRecording(payload.sourceIndex, payload.name);
    case 'stop-recording':
      return guiCore.stopRecording();
    default:
      throw new Error(`Unknown action: ${action}`);
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

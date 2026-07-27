const path = require('node:path');
const { app, BrowserWindow, dialog, shell } = require('electron');

let mainWindow = null;

// Citation cards and scraped-source links are attacker-influenceable content. By
// default Electron opens `target="_blank"` in a new BrowserWindow that INHERITS
// webPreferences — including the preload script — so a clicked link would hold
// `window.sidekick` and could read settings (API keys), conversations, and the whole
// corpus. Every external navigation therefore goes to the OS browser instead, and
// in-app navigation away from our own origin is denied outright.
function hardenNavigation(contents) {
  const isExternal = (rawUrl) => {
    try {
      const protocol = new URL(rawUrl).protocol;
      return protocol === 'https:' || protocol === 'http:';
    } catch (_error) {
      return false;
    }
  };

  contents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) {
      shell.openExternal(url).catch((error) => {
        console.error('Failed to open external URL:', error.message);
      });
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL();
    if (url === current) {
      return;
    }
    // Allow the dev server / local app origin to navigate (HMR, reloads); send
    // anything else to the OS browser.
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    const sameOrigin =
      (devServerUrl && url.startsWith(devServerUrl)) || url.startsWith('file://');
    if (sameOrigin) {
      return;
    }

    event.preventDefault();
    if (isExternal(url)) {
      shell.openExternal(url).catch((error) => {
        console.error('Failed to open external URL:', error.message);
      });
    }
  });

  // Never allow a renderer to attach a preload-bearing webview.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#100d0c',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  hardenNavigation(mainWindow.webContents);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const previewMode = process.env.PREVIEW === 'true';

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Renderer failed to load:', {
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited unexpectedly:', details);
  });

  if (devServerUrl) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else if (previewMode) {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// Auto-update is strictly opt-in and must never break a local or unpublished build.
// It only runs in a packaged app that was built with a publish target, and every
// failure is swallowed — a user who cannot reach the update server should still get
// a working offline app, which is the whole point of this product.
function initAutoUpdate() {
  if (!app.isPackaged || process.env.SIDEKICK_DISABLE_UPDATES === '1') {
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false; // never consume bandwidth without asking
    autoUpdater.on('error', (error) => {
      console.error('Update check failed (non-fatal):', error.message);
    });
    autoUpdater.on('update-available', (info) => {
      console.log('Update available:', info.version);
      if (mainWindow) {
        mainWindow.webContents.send('events:update-available', { version: info.version });
      }
    });
    autoUpdater.checkForUpdates().catch(() => {
      // No publish target configured, or offline. Both are fine.
    });
  } catch (error) {
    console.error('Auto-update unavailable (non-fatal):', error.message);
  }
}

async function bootstrap() {
  try {
    const { registerIpcHandlers } = require('./ipc.cjs');
    registerIpcHandlers({
      userDataPath: app.getPath('userData'),
    });
    createWindow();
    initAutoUpdate();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (error) {
    console.error('Sidekick failed to start:', error);
    dialog.showErrorBox(
      'Sidekick failed to start',
      `${error.message}\n\nIf this mentions better-sqlite3, run "npm run rebuild:native" and start the app again.`,
    );
    app.quit();
  }
}

app.whenReady().then(bootstrap).catch((error) => {
  console.error('Electron bootstrap failed:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

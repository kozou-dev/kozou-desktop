// Electron main process: window lifecycle, egress hardening, profile store,
// and the inspect IPC surface. The app opens no server and no port — the only
// network peer is the user's own database, reached from short-lived workers.

import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, safeStorage, session, shell } from 'electron';
import type { ProfileInput } from '../shared/types.js';
import { IPC } from '../shared/types.js';
import { runInspectWorker } from './inspectRunner.js';
import { ProfileStore, type Encryptor } from './profileStore.js';

// Test hook: e2e runs point userData at a temp dir so trial/dev profiles
// never mix with real ones.
const userDataOverride = process.env.KOZOU_DESKTOP_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);

const safeStorageEncryptor: Encryptor = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString('base64'),
  decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, 'base64')),
};

let store: ProfileStore;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // Egress/exposure hardening (see EGRESS.md): sandboxed renderer, no
      // Node integration, no spellchecker (its dictionary auto-download is
      // an external network call on some platforms).
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Never navigate away from our own UI; open nothing external.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Documentation links (https only) go to the OS browser, not into the app.
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  session.defaultSession.setSpellCheckerEnabled(false);

  store = new ProfileStore(join(app.getPath('userData'), 'store'), safeStorageEncryptor);

  ipcMain.handle(IPC.profilesList, () => store.list());
  ipcMain.handle(IPC.profilesSave, (_e, input: ProfileInput) => store.upsert(input));
  ipcMain.handle(IPC.profilesDelete, (_e, name: string) => store.remove(name));
  ipcMain.handle(IPC.inspectRun, async (_e, name: string) => {
    const connection = store.connectionUrl(name);
    const workerPath = join(import.meta.dirname, 'inspectWorker.js');
    return runInspectWorker(workerPath, connection);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

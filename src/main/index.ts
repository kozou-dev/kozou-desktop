// Electron main process: window lifecycle, egress hardening, profile store,
// and the inspect IPC surface. The app opens no server and no port — the only
// network peer is the user's own database, reached from short-lived workers.

import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, safeStorage, session } from 'electron';
import { IPC } from '../shared/types.js';
import { runInspectWorker } from './inspectRunner.js';
import { ProfileStore, validateProfileInput, type Encryptor } from './profileStore.js';

// Test hooks (dev/e2e only): a packaged app must never honor env overrides —
// ELECTRON_RENDERER_URL with the preload bridge attached would hand the
// kozouDesktop API to an arbitrary page.
const isDev = !app.isPackaged;
const userDataOverride = isDev ? process.env.KOZOU_DESKTOP_USER_DATA : undefined;
if (userDataOverride) app.setPath('userData', userDataOverride);

/** True when safeStorage really is backed by an OS keychain. On Linux,
 *  `isEncryptionAvailable()` also returns true for the `basic_text` backend
 *  (a hardcoded key — obfuscation, not encryption, and selectable by anyone
 *  via `--password-store=basic`), so that backend is rejected explicitly. */
function keychainBackedEncryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return false;
  }
  return true;
}

const safeStorageEncryptor: Encryptor = {
  available: keychainBackedEncryptionAvailable,
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

  // Never navigate away from our own UI, never open new windows. The M1 UI
  // has no external links; when docs links land, reintroduce an explicit
  // https allowlist handed to the OS browser — until then, deny everything.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  session.defaultSession.setSpellCheckerEnabled(false);

  store = new ProfileStore(join(app.getPath('userData'), 'store'), safeStorageEncryptor);

  ipcMain.handle(IPC.profilesList, () => store.list());
  ipcMain.handle(IPC.profilesSave, (_e, input: unknown) => store.upsert(validateProfileInput(input)));
  ipcMain.handle(IPC.profilesDelete, (_e, name: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    return store.remove(name);
  });
  ipcMain.handle(IPC.inspectRun, async (_e, name: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
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

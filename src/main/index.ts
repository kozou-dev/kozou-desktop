// Electron main process: window lifecycle, egress hardening, profile store,
// and the inspect/MCP IPC surfaces. By default the app opens no server and no
// port — the only network peer is the user's own database, reached from
// short-lived workers. The one exception is the opt-in local MCP mode
// (default off), which listens on 127.0.0.1 only to serve read-only describe
// tools to AI clients on the same machine; outbound traffic is still only
// the user's own databases.

import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, safeStorage, session } from 'electron';
import { IPC, type McpStatusEntry } from '../shared/types.js';
import { electronMcpWorkerFork } from './electronFork.js';
import { runInspectWorker } from './inspectRunner.js';
import { McpServerManager } from './mcpServerManager.js';
import { ProfileStore, validateProfileInput, type Encryptor } from './profileStore.js';

// Pin the machine-facing identity to a stable slug. userData, the keychain
// service name (safeStorage), and the single-instance lock scope all derive
// from app.getName() — keeping it fixed here decouples them from the
// human-facing display name. The packaged build shows "Kozou" in Dock/
// Spotlight via CFBundleDisplayName (electron-builder productName); because
// getName() stays "kozou-desktop", a future rename or localization of that
// display name never strands a user's profiles or keychain entries. As a
// side effect the packaged app and a source-run (`pnpm start`) share one
// store — intended for now; a dev-only "-dev" suffix can split them later
// without changing the packaged identity. Must run before anything derives a
// path from the name — the single-instance lock (below) and the profile store
// (in whenReady) both do.
app.setName('kozou-desktop');

// Test hooks (dev/e2e only): a packaged app must never honor env overrides —
// ELECTRON_RENDERER_URL with the preload bridge attached would hand the
// kozouDesktop API to an arbitrary page.
const isDev = !app.isPackaged;
const userDataOverride = isDev ? process.env.KOZOU_DESKTOP_USER_DATA : undefined;
if (userDataOverride) app.setPath('userData', userDataOverride);

// Two live instances would fight over profiles.json and the MCP port
// allocations (mutual EADDRINUSE) — refuse to be the second one. The lock is
// per userData path, so e2e runs with their own KOZOU_DESKTOP_USER_DATA are
// unaffected.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

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
let mcpManager: McpServerManager;

function broadcastMcpStatus(entries: McpStatusEntry[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // Exit events fire during quit teardown — never send into a destroyed
    // webContents.
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(IPC.mcpStatusChanged, entries);
  }
}

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
  if (!hasSingleInstanceLock) return;
  session.defaultSession.setSpellCheckerEnabled(false);

  store = new ProfileStore(join(app.getPath('userData'), 'store'), safeStorageEncryptor);
  mcpManager = new McpServerManager(
    store,
    () => join(import.meta.dirname, 'mcpServerWorker.js'),
    electronMcpWorkerFork,
    () => broadcastMcpStatus(mcpManager.status()),
  );

  ipcMain.handle(IPC.profilesList, () => store.list());
  ipcMain.handle(IPC.profilesSave, async (_e, input: unknown) => {
    const validated = validateProfileInput(input);
    // Only a connection-relevant edit (URL incl. password, or schemas)
    // invalidates a running server's fork-time connection — stop it before
    // the store changes rather than serve the old database. Label/color
    // edits keep the server (and its AI-client sessions) running.
    let connectionChanged = false;
    const existing = store.list().find((p) => p.name === validated.name);
    if (existing !== undefined) {
      try {
        const current = store.connectionUrl(validated.name);
        connectionChanged =
          current.url !== validated.url ||
          JSON.stringify(current.schemas) !== JSON.stringify(validated.schemas);
      } catch {
        connectionChanged = true;
      }
    }
    if (connectionChanged) await mcpManager.onProfileUpserted(validated.name);
    return store.upsert(validated);
  });
  ipcMain.handle(IPC.profilesDelete, async (_e, name: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    await mcpManager.onProfileRemoved(name);
    return store.remove(name);
  });
  ipcMain.handle(IPC.inspectRun, async (_e, name: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    const connection = store.connectionUrl(name);
    const workerPath = join(import.meta.dirname, 'inspectWorker.js');
    return runInspectWorker(workerPath, connection);
  });

  ipcMain.handle(IPC.mcpModeGet, () => store.mcpMode());
  ipcMain.handle(IPC.mcpModeSet, async (_e, mode: unknown) => {
    // Validate + persist FIRST: junk input must throw before any side
    // effect, and once the mode is no longer 'local' every queued/racing
    // start fails its mode check — so the sweep below cannot race a live
    // server back in. Modes are exclusive; per-profile autoStart intents
    // survive for the next 'local' launch.
    const next = store.setMcpMode(mode);
    if (next !== 'local') await mcpManager.stopAll();
    return next;
  });
  ipcMain.handle(IPC.mcpStart, (_e, name: unknown, opts: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    const override = typeof opts === 'object' && opts !== null && (opts as { override?: unknown }).override === true;
    return mcpManager.start(name, { override });
  });
  ipcMain.handle(IPC.mcpStop, (_e, name: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    return mcpManager.stop(name);
  });
  ipcMain.handle(IPC.mcpStatus, () => mcpManager.status());
  ipcMain.handle(IPC.mcpReassignPort, (_e, name: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    return mcpManager.reassignPort(name);
  });

  createWindow();

  // Launch-time restore of autoStart servers (no-op unless mode is 'local').
  void mcpManager.restoreAutoStart();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// App lifetime bounds MCP lifetime: kill every server child on the way out.
// Chromium additionally reaps utility processes with the main process, so a
// crashed main leaves no orphans either (verified — see EGRESS.md).
app.on('before-quit', () => {
  mcpManager?.killAllSync();
});

app.on('window-all-closed', () => {
  app.quit();
});

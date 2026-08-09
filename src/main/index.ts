// Electron main process: window lifecycle, egress hardening, profile store,
// and the inspect/MCP IPC surfaces. By default the app opens no server and no
// port — the only network peer is the user's own database, reached from
// short-lived workers. The one exception is the opt-in local MCP hub, which
// needs both an app-wide permission (off by default) and a per-profile start:
// once started it listens on 127.0.0.1 only to serve read-only describe tools
// to AI clients on the same machine; outbound traffic is still only the user's
// own databases.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, safeStorage, session, type MessageBoxOptions } from 'electron';
import { LOCATOR_DIR_NAME } from '../shared/mcpLocator.js';
import { IPC, type McpStatusEntry, type SaveSqlOutcome } from '../shared/types.js';
import { DataWorkerManager } from './dataWorkerManager.js';
import {
  validateListParams,
  validateProfileName,
  validateResourceName,
  validateRowId,
  validateValues,
} from './dataInput.js';
import { electronDataWorkerFork, electronMcpWorkerFork } from './electronFork.js';
import { runInspectWorker } from './inspectRunner.js';
import { FileMcpLocatorWriter } from './mcpLocatorFile.js';
import { McpServerManager } from './mcpServerManager.js';
import { ProfileStore, validateProfileInput, type Encryptor } from './profileStore.js';
import { assertRowAccess, requestRowAccessChange, type RowAccessApproval } from './rowAccessGate.js';
import { suggestedFileName, validateSqlExport } from './sqlExport.js';

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

/** The trust anchor for a row-access escalation: a native dialog drawn by
 *  main, modal to the window. Never a renderer modal — a compromised renderer
 *  could draw and "click" its own. Approval is the affirmative button only;
 *  Esc and the window close both land on cancelId. The prompt names the
 *  database, not just the profile: the profile is a label the renderer can
 *  change, the connection is what the grant actually reaches. */
const rowAccessApproval: RowAccessApproval = async ({ profile, level, connection }) => {
  const write = level === 'readwrite';
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['Cancel', write ? 'Enable row editing' : 'Enable row browsing'],
    defaultId: 0,
    cancelId: 0,
    title: 'Enable row data access',
    message: write
      ? `Allow row editing for the profile "${profile}"?`
      : `Allow row browsing for the profile "${profile}"?`,
    detail:
      `Database: ${connection}\n\n` +
      (write
        ? 'Row editing runs INSERT, UPDATE and DELETE statements against this database using the credentials stored for this profile. ' +
          'Deleted or overwritten rows cannot be restored by this app, and the database enforces the final say on what your role may change. ' +
          'Introspection and the local MCP surface stay read-only.'
        : 'Row browsing reads table and view data from this database using the credentials stored for this profile. ' +
          'Row data is only displayed — it is never uploaded and never written to disk. ' +
          'Introspection and the local MCP surface stay read-only.'),
  };
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const { response } =
    win !== undefined && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
  return response === 1;
};

let store: ProfileStore;
let mcpManager: McpServerManager;
let dataManager: DataWorkerManager;

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
  // Nothing is serving yet, so any locator on disk is a leftover from a crash
  // or a kill -9. Sweep before the restore below publishes the real ones.
  const locators = new FileMcpLocatorWriter(join(app.getPath('userData'), LOCATOR_DIR_NAME));
  locators.clearAll();
  mcpManager = new McpServerManager(
    store,
    () => join(import.meta.dirname, 'mcpServerWorker.js'),
    electronMcpWorkerFork,
    locators,
    () => broadcastMcpStatus(mcpManager.status()),
  );
  dataManager = new DataWorkerManager(
    store,
    () => join(import.meta.dirname, 'dataWorker.js'),
    electronDataWorkerFork,
  );

  ipcMain.handle(IPC.profilesList, () => store.list());
  ipcMain.handle(IPC.profilesSave, async (_e, input: unknown) => {
    const validated = validateProfileInput(input);
    // Only a connection-relevant edit (URL incl. password, or schemas)
    // invalidates a running server's fork-time connection — stop it before
    // the store changes rather than serve the old database. Label/color
    // edits keep the server (and its AI-client sessions) running.
    let connectionChanged = false;
    // The data worker additionally bakes in the statement timeout at fork time,
    // so a timeout edit invalidates it even when the connection is untouched —
    // otherwise the worker would keep enforcing the old budget while main
    // measured the new one against it.
    let timeoutChanged = false;
    const existing = store.list().find((p) => p.name === validated.name);
    if (existing !== undefined) {
      timeoutChanged = existing.timeoutMs !== validated.timeoutMs;
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
    if (connectionChanged || timeoutChanged) dataManager.onProfileUpserted(validated.name);
    return store.upsert(validated);
  });
  ipcMain.handle(IPC.profilesDelete, async (_e, name: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    await mcpManager.onProfileRemoved(name);
    dataManager.onProfileRemoved(name);
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
  // Row access lives on its own channel, apart from profiles:save: the
  // renderer asks, main decides (native dialog), the store records. A change
  // in either direction discards the profile's data worker — its capability is
  // fixed at fork time, so neither a revocation nor an escalation may be
  // applied to a running one.
  ipcMain.handle(IPC.dataSetRowAccess, async (_e, name: unknown, level: unknown) => {
    const before = typeof name === 'string' ? store.rowAccess(name) : undefined;
    const after = await requestRowAccessChange(store, rowAccessApproval, name, level);
    if (typeof name === 'string' && after !== before) dataManager.onRowAccessChanged(name);
    return after;
  });

  // Every row-data channel passes the main-owned gate first: assertRowAccess
  // throws unless the profile is opted in at the level the operation needs, so
  // nothing is forked and no database is touched for a profile that is 'off'.
  // The worker's own fork-time capability is the second half of that check.
  ipcMain.handle(IPC.dataList, (_e, name: unknown, resource: unknown, params: unknown) => {
    const profile = validateProfileName(name);
    assertRowAccess(store, profile, 'read');
    const listParams = validateListParams(params);
    return dataManager.run(profile, {
      kind: 'list',
      resource: validateResourceName(resource),
      ...(listParams !== undefined ? { params: listParams } : {}),
    });
  });
  ipcMain.handle(IPC.dataGet, (_e, name: unknown, resource: unknown, id: unknown) => {
    const profile = validateProfileName(name);
    assertRowAccess(store, profile, 'read');
    return dataManager.run(profile, {
      kind: 'get',
      resource: validateResourceName(resource),
      id: validateRowId(id),
    });
  });
  ipcMain.handle(IPC.dataInsert, (_e, name: unknown, resource: unknown, values: unknown) => {
    const profile = validateProfileName(name);
    assertRowAccess(store, profile, 'readwrite');
    return dataManager.run(profile, {
      kind: 'insert',
      resource: validateResourceName(resource),
      values: validateValues(values),
    });
  });
  ipcMain.handle(
    IPC.dataUpdate,
    (_e, name: unknown, resource: unknown, id: unknown, values: unknown) => {
      const profile = validateProfileName(name);
      assertRowAccess(store, profile, 'readwrite');
      return dataManager.run(profile, {
        kind: 'update',
        resource: validateResourceName(resource),
        id: validateRowId(id),
        values: validateValues(values),
      });
    },
  );
  ipcMain.handle(IPC.dataDelete, (_e, name: unknown, resource: unknown, id: unknown) => {
    const profile = validateProfileName(name);
    assertRowAccess(store, profile, 'readwrite');
    return dataManager.run(profile, {
      kind: 'delete',
      resource: validateResourceName(resource),
      id: validateRowId(id),
    });
  });

  // Save drafted DDL to a file. No profile, no gate, no database: the payload
  // is text the renderer generated from a schema it was already shown, and the
  // destination is whatever the user picks in the native dialog. The gate that
  // matters here is that dialog — without a chosen path nothing is written.
  ipcMain.handle(IPC.emitSaveSql, async (_e, name: unknown, sql: unknown): Promise<SaveSqlOutcome> => {
    const text = validateSqlExport(sql);
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Save COMMENT statements',
      defaultPath: suggestedFileName(name),
      filters: [{ name: 'SQL', extensions: ['sql'] }],
    };
    const { canceled, filePath } =
      win !== undefined && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
    if (canceled || filePath === undefined || filePath === '') return { saved: false };
    await writeFile(filePath, text, 'utf8');
    return { saved: true };
  });

  ipcMain.handle(IPC.mcpStatus, () => mcpManager.status());
  ipcMain.handle(IPC.mcpReassignPort, (_e, name: unknown) => {
    if (typeof name !== 'string') throw new Error('profile name must be a string');
    return mcpManager.reassignPort(name);
  });
  // Where a client would find the bridge. Read from this process rather than
  // built in the renderer: only main knows where the app actually is, and the
  // script sits beside it in the same build output (packaged: inside app.asar,
  // which the binary can run as Node).
  ipcMain.handle(IPC.mcpBridgeLauncher, () => ({
    command: process.execPath,
    script: join(import.meta.dirname, 'stdioBridge.js'),
  }));

  createWindow();

  // Launch-time restore of autoStart servers (no-op unless mode is 'local').
  void mcpManager.restoreAutoStart();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// App lifetime bounds worker lifetime: kill every server and data child on the
// way out. Chromium additionally reaps utility processes with the main process,
// so a crashed main leaves no orphans either (verified — see EGRESS.md).
app.on('before-quit', () => {
  mcpManager?.killAllSync();
  dataManager?.killAllSync();
});

app.on('window-all-closed', () => {
  app.quit();
});

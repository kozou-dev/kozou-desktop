// Preload: the only bridge between the sandboxed renderer and the main
// process. Exposes a typed, minimal API — no raw ipcRenderer, no Node.

import { contextBridge, ipcRenderer } from 'electron';
import type { KozouDesktopApi, ProfileInput } from '../shared/types.js';
import { IPC } from '../shared/types.js';

const api: KozouDesktopApi = {
  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  saveProfile: (input: ProfileInput) => ipcRenderer.invoke(IPC.profilesSave, input),
  deleteProfile: (name: string) => ipcRenderer.invoke(IPC.profilesDelete, name),
  inspect: (name: string) => ipcRenderer.invoke(IPC.inspectRun, name),
};

contextBridge.exposeInMainWorld('kozouDesktop', api);

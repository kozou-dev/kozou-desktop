// Preload: the only bridge between the sandboxed renderer and the main
// process. Exposes a typed, minimal API — no raw ipcRenderer, no Node.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { KozouDesktopApi, McpMode, McpStatusEntry, ProfileInput } from '../shared/types.js';
import { IPC } from '../shared/types.js';

const api: KozouDesktopApi = {
  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  saveProfile: (input: ProfileInput) => ipcRenderer.invoke(IPC.profilesSave, input),
  deleteProfile: (name: string) => ipcRenderer.invoke(IPC.profilesDelete, name),
  inspect: (name: string) => ipcRenderer.invoke(IPC.inspectRun, name),
  mcpModeGet: () => ipcRenderer.invoke(IPC.mcpModeGet),
  mcpModeSet: (mode: McpMode) => ipcRenderer.invoke(IPC.mcpModeSet, mode),
  mcpStart: (name: string, opts?: { override?: boolean }) => ipcRenderer.invoke(IPC.mcpStart, name, opts),
  mcpStop: (name: string) => ipcRenderer.invoke(IPC.mcpStop, name),
  mcpStatus: () => ipcRenderer.invoke(IPC.mcpStatus),
  mcpReassignPort: (name: string) => ipcRenderer.invoke(IPC.mcpReassignPort, name),
  onMcpStatusChanged: (listener: (entries: McpStatusEntry[]) => void) => {
    const wrapped = (_e: IpcRendererEvent, entries: McpStatusEntry[]): void => listener(entries);
    ipcRenderer.on(IPC.mcpStatusChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.mcpStatusChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld('kozouDesktop', api);

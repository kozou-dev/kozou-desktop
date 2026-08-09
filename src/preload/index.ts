// Preload: the only bridge between the sandboxed renderer and the main
// process. Exposes a typed, minimal API — no raw ipcRenderer, no Node.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DataListParams,
  KozouDesktopApi,
  McpMode,
  McpStatusEntry,
  ProfileInput,
  RowAccess,
} from '../shared/types.js';
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
  mcpBridgeLauncher: () => ipcRenderer.invoke(IPC.mcpBridgeLauncher),
  requestRowAccess: (name: string, level: RowAccess) => ipcRenderer.invoke(IPC.dataSetRowAccess, name, level),
  dataList: (name: string, resource: string, params?: DataListParams) =>
    ipcRenderer.invoke(IPC.dataList, name, resource, params),
  dataGet: (name: string, resource: string, id: string) =>
    ipcRenderer.invoke(IPC.dataGet, name, resource, id),
  dataInsert: (name: string, resource: string, values: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.dataInsert, name, resource, values),
  dataUpdate: (name: string, resource: string, id: string, values: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.dataUpdate, name, resource, id, values),
  dataDelete: (name: string, resource: string, id: string) =>
    ipcRenderer.invoke(IPC.dataDelete, name, resource, id),
  saveSqlFile: (suggestedName: string, sql: string) =>
    ipcRenderer.invoke(IPC.emitSaveSql, suggestedName, sql),
  onMcpStatusChanged: (listener: (entries: McpStatusEntry[]) => void) => {
    const wrapped = (_e: IpcRendererEvent, entries: McpStatusEntry[]): void => listener(entries);
    ipcRenderer.on(IPC.mcpStatusChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.mcpStatusChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld('kozouDesktop', api);

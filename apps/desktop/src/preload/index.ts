import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type ConclaveApi, type InstallLog, type RunUpdate } from '../shared/api.js';

const invoke = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const api: ConclaveApi = {
  accounts: {
    list: () => invoke(IPC.accountsList),
    signIn: (provider) => invoke(IPC.accountsSignIn, provider),
    install: (provider) => invoke(IPC.accountsInstall, provider),
    quotas: () => invoke(IPC.accountsQuotas),
  },
  threads: {
    list: () => invoke(IPC.threadsList),
    get: (id) => invoke(IPC.threadsGet, id),
    rename: (id, title) => invoke(IPC.threadsRename, id, title),
    remove: (id) => invoke(IPC.threadsRemove, id),
  },
  chat: {
    create: (seat) => invoke(IPC.chatCreate, seat),
    send: (input) => invoke(IPC.chatSend, input),
  },
  council: {
    ask: (input) => invoke(IPC.councilAsk, input),
  },
  runs: {
    cancel: (requestId) => invoke(IPC.runsCancel, requestId),
    onUpdate: (listener) => listen<RunUpdate>(IPC.runUpdate, listener),
  },
  onInstallLog: (listener) => listen<InstallLog>(IPC.installLog, listener),
  openExternal: (url) => invoke(IPC.openExternal, url),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('conclave', api);

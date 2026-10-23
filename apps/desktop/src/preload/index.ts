import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BrainEvent } from '@conclave/shared';
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
  projects: {
    list: () => invoke(IPC.projectsList),
    get: (id) => invoke(IPC.projectsGet, id),
    pickRepo: () => invoke(IPC.projectsPickRepo),
    inspectRepo: (path) => invoke(IPC.projectsInspectRepo, path),
    inspectFolder: (path) => invoke(IPC.projectsInspectFolder, path),
    setUpGit: (path, confirmLarge) => invoke(IPC.projectsSetUpGit, path, confirmLarge),
    createFolder: (name, parent) => invoke(IPC.projectsCreateFolder, name, parent),
    defaultFolder: () => invoke(IPC.projectsDefaultFolder),
    create: (input) => invoke(IPC.projectsCreate, input),
    update: (id, settings) => invoke(IPC.projectsUpdate, id, settings),
    clarify: (id) => invoke(IPC.projectsClarify, id),
    startDraft: (id, input) => invoke(IPC.projectsStartDraft, id, input),
    retry: (taskId, opts) => invoke(IPC.projectsRetry, taskId, opts),
    skip: (taskId) => invoke(IPC.projectsSkip, taskId),
    retryFailed: (projectId, filter, opts) =>
      invoke(IPC.projectsRetryFailed, projectId, filter, opts),
    permissionGaps: (permissions) => invoke(IPC.projectsPermissionGaps, permissions),
    start: (id) => invoke(IPC.projectsStart, id),
    stop: (id) => invoke(IPC.projectsStop, id),
    remove: (id) => invoke(IPC.projectsRemove, id),
    taskChanges: (taskId) => invoke(IPC.projectsTaskChanges, taskId),
    onEvent: (listener) => listen<BrainEvent>(IPC.projectsEvent, listener),
  },
  decisions: {
    add: (projectId, question, answer) => invoke(IPC.decisionsAdd, projectId, question, answer),
    keep: (id) => invoke(IPC.decisionsKeep, id),
    change: (id, answer, addTask) => invoke(IPC.decisionsChange, id, answer, addTask),
  },
  approvals: {
    list: () => invoke(IPC.approvalsList),
    decide: (id, decision, opts) => invoke(IPC.approvalsDecide, id, decision, opts),
  },
  github: {
    status: () => invoke(IPC.githubStatus),
    signIn: () => invoke(IPC.githubSignIn),
    repos: (owner) => invoke(IPC.githubRepos, owner),
    clone: (repo, parent) => invoke(IPC.githubClone, repo, parent),
    issues: (repoPath) => invoke(IPC.githubIssues, repoPath),
    prStatus: (projectId) => invoke(IPC.githubPrStatus, projectId),
    fixCheck: (projectId, check) => invoke(IPC.githubFixCheck, projectId, check),
    publish: (projectId, input) => invoke(IPC.githubPublish, projectId, input),
  },
  usage: {
    report: () => invoke(IPC.usageReport),
  },
  onInstallLog: (listener) => listen<InstallLog>(IPC.installLog, listener),
  openExternal: (url) => invoke(IPC.openExternal, url),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('conclave', api);

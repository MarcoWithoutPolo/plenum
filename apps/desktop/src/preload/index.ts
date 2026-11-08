import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppearanceSettings, BrainEvent } from '@plenum/shared';
import { applyLook } from '../shared/look.js';
import {
  IPC,
  type PlenumApi,
  type InstallLog,
  type RunUpdate,
  type UpdateState,
} from '../shared/api.js';

const invoke = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const api: PlenumApi = {
  accounts: {
    list: () => invoke(IPC.accountsList),
    signIn: (provider) => invoke(IPC.accountsSignIn, provider),
    install: (provider) => invoke(IPC.accountsInstall, provider),
    hasNpm: () => invoke(IPC.accountsHasNpm),
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
    skip: (requestId, index) => invoke(IPC.councilSkip, requestId, index),
    mergeNow: (requestId) => invoke(IPC.councilMergeNow, requestId),
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
    clarify: (id, answers) => invoke(IPC.projectsClarify, id, answers),
    startDraft: (id, input) => invoke(IPC.projectsStartDraft, id, input),
    retry: (taskId, opts) => invoke(IPC.projectsRetry, taskId, opts),
    skip: (taskId) => invoke(IPC.projectsSkip, taskId),
    moveTask: (taskId, direction) => invoke(IPC.projectsMoveTask, taskId, direction),
    editTask: (taskId, patch) => invoke(IPC.projectsEditTask, taskId, patch),
    addTask: (projectId, input) => invoke(IPC.projectsAddTask, projectId, input),
    steering: (projectId) => invoke(IPC.projectsSteering, projectId),
    steer: (projectId, text) => invoke(IPC.projectsSteer, projectId, text),
    applySteering: (messageId, indexes) => invoke(IPC.projectsApplySteering, messageId, indexes),
    dismissSteering: (messageId) => invoke(IPC.projectsDismissSteering, messageId),
    preview: (projectId, taskId) => invoke(IPC.projectsPreview, projectId, taskId),
    allowPreview: (projectId, command, taskId) =>
      invoke(IPC.projectsAllowPreview, projectId, command, taskId),
    stopPreview: (projectId, taskId) => invoke(IPC.projectsStopPreview, projectId, taskId),
    previewLogs: (projectId, taskId) => invoke(IPC.projectsPreviewLogs, projectId, taskId),
    snapshots: (projectId, taskId) => invoke(IPC.projectsSnapshots, projectId, taskId),
    shot: (path) => invoke(IPC.projectsShot, path),
    retryFailed: (projectId, filter, opts) =>
      invoke(IPC.projectsRetryFailed, projectId, filter, opts),
    permissionGaps: (permissions) => invoke(IPC.projectsPermissionGaps, permissions),
    syncState: (id) => invoke(IPC.projectsSyncState, id),
    tryTest: (folder, command) => invoke(IPC.projectsTryTest, folder, command),
    pushBase: (id) => invoke(IPC.projectsPushBase, id),
    teamInsights: (routing) => invoke(IPC.projectsTeamInsights, routing),
    start: (id, at) => invoke(IPC.projectsStart, id, at),
    startCheck: (id) => invoke(IPC.projectsStartCheck, id),
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
  local: {
    pull: (model) => invoke(IPC.localPull, model),
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch),
  },
  about: {
    info: () => invoke(IPC.about),
    exportLogs: () => invoke(IPC.diagnosticsExport),
  },
  updates: {
    get: () => invoke(IPC.updateGet),
    check: () => invoke(IPC.updateCheck),
    restart: () => invoke(IPC.updateRestart),
    onChange: (listener) => listen<UpdateState>(IPC.updateChanged, listener),
  },
  onOpenProject: (listener) => listen<string>(IPC.openProject, listener),
  onOpenInbox: (listener) => listen<void>(IPC.openInbox, listener),
  onInstallLog: (listener) => listen<InstallLog>(IPC.installLog, listener),
  openExternal: (url) => invoke(IPC.openExternal, url),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('plenum', api);

// The look (F3) is on the page before it first paints: no flash of the wrong contrast or motion.
try {
  const look = ipcRenderer.sendSync(IPC.appearanceGet) as AppearanceSettings | undefined;
  if (look) {
    // The parser makes the page's own <html> after this runs: set it once that exists, which is
    // still before the first paint.
    const apply = () => applyLook(document.documentElement, look);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
    else apply();
  }
} catch {
  // The defaults (from the stylesheet) until the app loads its settings.
}

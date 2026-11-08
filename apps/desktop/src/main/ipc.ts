import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  ChatSendInput,
  CouncilAskInput,
  PROVIDERS as REGISTRY,
  Seat,
  WireId,
  type ProviderId,
} from '@plenum/shared';
import {
  CouncilControl,
  INSTALL_PACKAGES,
  LocalAdapter,
  activeLimits,
  runCommand,
  streamProcess,
  type Engine,
} from '@plenum/core';
import { demoFailure, demoSignIn } from './demo.js';

import { IPC, type CouncilRoundResult, type ProviderInfo, type RunUpdate } from '../shared/api.js';
import { openInTerminal } from './terminal.js';
import { refreshWindowsPath } from './winpath.js';

/** npm comes with Node.js, which a new computer may not have. */
async function hasNpm(): Promise<boolean> {
  if (process.env.PLENUM_DEMO === '1') return !process.env.PLENUM_DEMO_NO_NPM;
  const works = async () =>
    (await runCommand('npm', ['--version'], { timeoutMs: 15_000 })).code === 0;
  if (await works().catch(() => false)) return true;
  // Installed since Plenum started? Then only the saved PATH knows about it.
  await refreshWindowsPath();
  return works().catch(() => false);
}

/** The demo can make calls fail on purpose (PLENUM_DEMO_FAIL), for the tests. */
const demo = process.env.PLENUM_DEMO === '1';

/** Real providers from the registry; the demo's fake one never comes from the renderer. */
const PROVIDERS = new Set<ProviderId>(REGISTRY.filter((p) => p.id !== 'fake').map((p) => p.id));

export function registerIpc(engine: Engine, getWindow: () => BrowserWindow | null): void {
  const running = new Map<string, AbortController>();
  const send = (channel: string, payload: unknown) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const update = (u: RunUpdate) => send(IPC.runUpdate, u);

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) =>
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (demo) demoFailure(channel);
      return fn(...(args as A));
    });

  const threadId = (value: unknown): string => WireId.parse(value);

  const adapter = (provider: unknown) => {
    if (typeof provider !== 'string' || !PROVIDERS.has(provider as ProviderId)) {
      throw new Error('Unknown provider');
    }
    const found = engine.adapters.get(provider as ProviderId);
    if (!found) throw new Error(`Provider not available: ${provider}`);
    return found;
  };

  /** Running council rounds, by request, for Skip and Merge now. */
  const councils = new Map<string, CouncilControl>();

  const track = (requestId: string) => {
    if (typeof requestId !== 'string' || !requestId) throw new Error('Missing request id');
    const controller = new AbortController();
    running.set(requestId, controller);
    return { signal: controller.signal, done: () => running.delete(requestId) };
  };

  handle(IPC.accountsList, async (): Promise<ProviderInfo[]> => {
    const statuses = await engine.detectAll();
    const limits = activeLimits(engine.store);
    return Promise.all(
      statuses.map(async (status) => {
        const a = engine.adapters.get(status.provider)!;
        const pkg = INSTALL_PACKAGES[status.provider];
        // Signed-out CLIs usually can't list models; don't wait on them.
        const listed =
          status.auth === 'signed_out' || !status.installed
            ? undefined
            : await engine.catalog(status.provider).catch(() => undefined);
        const models = listed?.models.length
          ? listed.models
          : a.capabilities.models.map((id) => ({ id }));
        return {
          ...status,
          displayName: a.displayName,
          models,
          ...(a.capabilities.efforts && { efforts: a.capabilities.efforts }),
          ...(listed?.defaultModel && { defaultModel: listed.defaultModel }),
          ...(listed?.defaultEffort && { defaultEffort: listed.defaultEffort }),
          ...(pkg && { installPackage: pkg }),
          ...((l) => (l ? { limit: { message: l.message, at: l.at } } : {}))(
            limits.find((x) => x.provider === status.provider),
          ),
          loginHint: a.login().hint,
        };
      }),
    );
  });

  handle(IPC.accountsSignIn, (provider: ProviderId) =>
    // The demo signs in by itself after a moment: no terminal, no real sign-in.
    demo ? demoSignIn(provider) : openInTerminal(adapter(provider).login()),
  );

  handle(IPC.accountsHasNpm, hasNpm);

  handle(IPC.accountsInstall, async (provider: ProviderId) => {
    const pkg = INSTALL_PACKAGES[provider];
    if (!pkg) return { ok: false, error: 'No installer for this provider' };
    if (!(await hasNpm())) return { ok: false, error: 'This install needs Node.js first.' };
    const win = getWindow();
    const options = {
      type: 'question' as const,
      buttons: ['Install', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install CLI',
      message: `Install ${adapter(provider).displayName}?`,
      detail: `Plenum will run:\n\nnpm install -g ${pkg}\n\nThis downloads the official package from the npm registry.`,
    };
    const choice = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (choice.response !== 0) return { ok: false, cancelled: true };

    let code: number | null = null;
    let error: string | undefined;
    for await (const chunk of streamProcess({
      command: 'npm',
      args: ['install', '-g', pkg],
      timeoutMs: 10 * 60_000,
    })) {
      if (chunk.kind === 'line') send(IPC.installLog, { provider, text: `${chunk.line}\n` });
      else if (chunk.kind === 'stderr') send(IPC.installLog, { provider, text: chunk.text });
      else {
        code = chunk.code;
        error = chunk.error;
      }
    }
    // npm's folder may be new to this app's PATH: the CLI should be found straight away.
    if (code === 0) await refreshWindowsPath();
    return code === 0
      ? { ok: true }
      : { ok: false, error: error ?? `npm exited with code ${code}` };
  });

  handle(IPC.localPull, async (model: unknown) => {
    const local = engine.adapters.get('local');
    if (!(local instanceof LocalAdapter))
      return { ok: false, error: 'Local models are not available' };
    if (typeof model !== 'string' || !/^[\w.:/-]{1,80}$/.test(model)) {
      return { ok: false, error: 'Not a model name' };
    }
    const win = getWindow();
    const options = {
      type: 'question' as const,
      buttons: ['Download', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Download a model',
      message: `Download ${model} into Ollama?`,
      detail:
        'Models are several gigabytes. Ollama downloads it from its own library and keeps it on this computer (or the Ollama address in Settings).',
    };
    const choice = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (choice.response !== 0) return { ok: false, cancelled: true };
    try {
      await local.pull(model, (text) => send(IPC.installLog, { provider: 'local', text }));
      await engine.catalog('local', { refresh: true }).catch(() => undefined);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle(IPC.accountsQuotas, async () => {
    // Providers that log their plan usage locally (Codex) are read fresh, at no cost.
    const at = Date.now();
    for (const a of engine.adapters.values()) {
      const limits = await a.limits?.().catch(() => []);
      for (const l of limits ?? []) {
        engine.store.recordQuota({
          provider: a.id,
          window: l.window,
          utilization: l.utilization,
          resetsAt: l.resetsAt ?? null,
          at,
        });
      }
    }
    return engine.store.listQuotas();
  });

  handle(IPC.threadsList, () => engine.store.listThreads(200));
  handle(IPC.threadsGet, (raw: unknown) => {
    const id = threadId(raw);
    const thread = engine.store.getThread(id);
    return thread ? { thread, messages: engine.store.listMessages(id) } : null;
  });
  handle(
    IPC.threadsRename,
    (id: unknown, title: unknown) =>
      engine.store.updateThread(threadId(id), {
        title: String(title).trim().slice(0, 200) || 'Untitled',
      }) ?? null,
  );
  handle(IPC.threadsRemove, (id: unknown) => engine.store.deleteThread(threadId(id)));

  handle(IPC.chatCreate, async (raw: unknown) => {
    const seat = Seat.parse(raw);
    // The demo can take a moment to create a chat, so a test can press Stop meanwhile (U10).
    if (demo && process.env.PLENUM_DEMO_SLOW_CREATE)
      await new Promise((r) => setTimeout(r, Number(process.env.PLENUM_DEMO_SLOW_CREATE)));
    adapter(seat.provider);
    return engine.chat.createThread(seat);
  });

  handle(IPC.chatSend, async (raw: unknown) => {
    const input = ChatSendInput.parse(raw);
    adapter(input.seat.provider);
    const run = track(input.requestId);
    try {
      const { thread, user, reply } = await engine.chat.send(input.threadId, input.text, {
        provider: input.seat.provider,
        model: input.seat.model ?? null,
        effort: input.seat.effort ?? null,
        signal: run.signal,
        onEvent: (event) => update({ requestId: input.requestId, kind: 'chat', event }),
      });
      return { thread, user, reply };
    } finally {
      run.done();
    }
  });

  handle(IPC.councilAsk, async (raw: unknown): Promise<CouncilRoundResult> => {
    const input = CouncilAskInput.parse(raw);
    for (const seat of [...input.members, input.synthesizer]) adapter(seat.provider);
    const run = track(input.requestId);
    const control = new CouncilControl();
    councils.set(input.requestId, control);
    const mergeAfter = engine.store.settings.get().council.mergeAfterMinutes;
    try {
      const result = await engine.council.ask(input.question, {
        members: input.members,
        synthesizer: input.synthesizer,
        signal: run.signal,
        control,
        ...(mergeAfter > 0 && { maxWaitMs: mergeAfter * 60_000 }),
        ...(input.threadId && { threadId: input.threadId }),
        onEvent: (u) =>
          update(
            u.phase === 'member'
              ? {
                  requestId: input.requestId,
                  kind: 'member',
                  index: u.index,
                  label: u.label,
                  seat: u.seat,
                  event: u.event,
                }
              : u.phase === 'skipped'
                ? { requestId: input.requestId, kind: 'skipped', index: u.index, reason: u.reason }
                : { requestId: input.requestId, kind: 'synthesis', seat: u.seat, event: u.event },
          ),
      });
      return {
        thread: result.thread,
        groupId: result.groupId,
        answers: result.answers.map((a) => ({
          seat: a.seat,
          label: a.label,
          message: a.message,
        })),
        merged: result.merged,
        mergedBy: result.mergedBy,
      };
    } finally {
      run.done();
      councils.delete(input.requestId);
    }
  });

  // Skip and Merge now while a round runs (F4); both do nothing once it's over.
  handle(IPC.councilSkip, (requestId: unknown, index: unknown) => {
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('Invalid member');
    councils.get(WireId.parse(requestId))?.skip(index);
  });
  handle(IPC.councilMergeNow, (requestId: unknown) => {
    councils.get(WireId.parse(requestId))?.mergeNow();
  });

  handle(IPC.runsCancel, (requestId: string) => {
    running.get(requestId)?.abort();
  });

  handle(IPC.openExternal, async (url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
}

import { createInterface } from 'node:readline/promises';
import { firstPreferred, type ProviderId, type Seat, type Thread } from '@plenum/shared';
import { parseSeat, type Engine } from '@plenum/core';
import { bold, dim, messageBlock, paint, seatName, shortId, stats, threadLine } from './format.js';

export interface ChatArgs {
  message?: string;
  seat?: Seat;
  threadId?: string;
}

const HELP = `Commands inside chat:
  /use <provider>[:model][@effort]  switch who answers, e.g. /use codex@low or /use claude:opus
  /model <name|default>    change the model for the current provider
  /effort <level|default>  reasoning effort, e.g. /effort low (faster, uses less of your plan)
  /new                     start a fresh chat
  /history                 show this chat so far
  /threads                 list recent chats
  /help                    show this help
  /exit                    leave (Ctrl+D works too)`;

export async function chatCommand(engine: Engine, args: ChatArgs): Promise<number> {
  let thread = await openThread(engine, args);
  if (!thread) return 1;

  if (args.message) {
    const ok = await sendOne(engine, thread, args.message, args.seat);
    console.log(
      dim(
        `\nthread ${shortId(thread.id)} · continue with: plenum chat --thread ${shortId(thread.id)}`,
      ),
    );
    return ok ? 0 : 1;
  }

  console.log(
    `${bold('Plenum chat')} ${dim(`· thread ${shortId(thread.id)} · /help for commands`)}`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => rl.close());
  try {
    while (true) {
      thread = engine.store.getThread(thread.id)!;
      const who = seatName({
        provider: thread.provider,
        ...(thread.model && { model: thread.model }),
        ...(thread.effort && { effort: thread.effort }),
      });
      let line: string;
      try {
        line = (await rl.question(paint('cyan', `${who} › `))).trim();
      } catch {
        break; // input closed
      }
      if (!line) continue;
      if (line.startsWith('/')) {
        const next = await slash(engine, thread, line);
        if (next === 'exit') break;
        if (next) thread = next;
        continue;
      }
      await sendOne(engine, thread, line);
    }
  } finally {
    rl.close();
  }
  return 0;
}

async function openThread(engine: Engine, args: ChatArgs): Promise<Thread | undefined> {
  if (args.threadId) {
    const found = engine.store.findThread(args.threadId);
    if (!found) console.error(`No chat found for "${args.threadId}". See: plenum threads`);
    return found;
  }
  const seat = args.seat ?? (await defaultSeat(engine));
  if (!seat) {
    console.error('No AI provider is signed in. Run: plenum doctor');
    return undefined;
  }
  return engine.chat.createThread(seat);
}

async function defaultSeat(engine: Engine): Promise<Seat | undefined> {
  const ready = await engine.readySeats();
  return firstPreferred(ready);
}

async function sendOne(
  engine: Engine,
  thread: Thread,
  text: string,
  seat?: Seat,
): Promise<boolean> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  let streamed = false;
  try {
    const { reply } = await engine.chat.send(thread.id, text, {
      ...(seat && {
        provider: seat.provider,
        model: seat.model ?? null,
        effort: seat.effort ?? null,
      }),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'message.delta') {
          streamed = true;
          process.stdout.write(event.text);
        }
      },
    });
    if (!reply.ok) {
      console.log((streamed ? '\n' : '') + paint('red', `Failed: ${reply.error}`));
      return false;
    }
    if (!streamed) process.stdout.write(reply.content);
    console.log(`\n${dim(stats(reply.durationMs, reply.usage))}\n`);
    return true;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function slash(
  engine: Engine,
  thread: Thread,
  line: string,
): Promise<Thread | 'exit' | undefined> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  try {
    switch (cmd) {
      case 'exit':
      case 'quit':
        return 'exit';
      case 'help':
        console.log(HELP);
        return;
      case 'use': {
        const seat = parseSeat(arg);
        requireProvider(engine, seat.provider);
        console.log(dim(`Now answering: ${seatName(seat)}. Earlier messages are shared with it.`));
        return engine.store.updateThread(thread.id, {
          provider: seat.provider,
          model: seat.model ?? null,
          effort: seat.effort ?? null,
        });
      }
      case 'model': {
        const model = !arg || arg === 'default' ? null : arg;
        console.log(dim(`Model: ${model ?? 'provider default'}`));
        return engine.store.updateThread(thread.id, { model });
      }
      case 'effort': {
        const effort = !arg || arg === 'default' ? null : arg;
        if (effort && !/^[a-z]+$/.test(effort)) throw new Error(`Invalid effort "${effort}"`);
        const levels = engine.adapters.get(thread.provider)?.capabilities.efforts;
        console.log(
          dim(
            `Effort: ${effort ?? 'CLI default'}${levels ? ` (options: ${levels.join(', ')})` : ''}`,
          ),
        );
        return engine.store.updateThread(thread.id, { effort });
      }
      case 'new': {
        const next = engine.chat.createThread({
          provider: thread.provider,
          ...(thread.model && { model: thread.model }),
          ...(thread.effort && { effort: thread.effort }),
        });
        console.log(dim(`New chat ${shortId(next.id)}`));
        return next;
      }
      case 'history':
        for (const m of engine.store.listMessages(thread.id)) console.log(`${messageBlock(m)}\n`);
        return;
      case 'threads':
        for (const t of engine.store.listThreads(15)) console.log(threadLine(t));
        return;
      default:
        console.log(`Unknown command /${cmd}. Try /help`);
        return;
    }
  } catch (err) {
    console.log(paint('red', (err as Error).message));
    return;
  }
}

function requireProvider(engine: Engine, provider: ProviderId): void {
  if (!engine.adapters.has(provider)) throw new Error(`Provider not available: ${provider}`);
}

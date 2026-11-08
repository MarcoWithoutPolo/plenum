import type { Engine } from '@plenum/core';
import { bold, dim, messageBlock, shortId, threadLine } from './format.js';

export function threadsCommand(engine: Engine): number {
  const threads = engine.store.listThreads(30);
  if (threads.length === 0) {
    console.log('No chats yet. Start one with: plenum chat');
    return 0;
  }
  for (const t of threads) console.log(threadLine(t));
  console.log(
    dim('\nOpen one with: plenum show <id>  ·  continue with: plenum chat --thread <id>'),
  );
  return 0;
}

export function showCommand(engine: Engine, id: string | undefined): number {
  const thread = id ? engine.store.findThread(id) : undefined;
  if (!thread) {
    console.error(id ? `No chat found for "${id}".` : 'Usage: plenum show <thread-id>');
    return 1;
  }
  console.log(`${bold(thread.title)} ${dim(`· ${thread.mode} · ${shortId(thread.id)}`)}\n`);
  for (const m of engine.store.listMessages(thread.id)) console.log(`${messageBlock(m)}\n`);
  return 0;
}

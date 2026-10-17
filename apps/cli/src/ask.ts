import type { Seat } from '@conclave/shared';
import type { CouncilUpdate, Engine } from '@conclave/core';
import { bold, dim, heading, paint, seatName, shortId, stats } from './format.js';

export interface AskArgs {
  question: string;
  members?: Seat[];
  synthesizer?: Seat;
  threadId?: string;
  json?: boolean;
}

export async function askCommand(engine: Engine, args: AskArgs): Promise<number> {
  const members = args.members ?? (await engine.readySeats());
  if (members.length === 0) {
    console.error('No AI provider is signed in. Run: conclave doctor');
    return 1;
  }
  const synthesizer =
    args.synthesizer ?? members.find((m) => m.provider === 'claude') ?? members[0]!;
  let threadId: string | undefined;
  if (args.threadId) {
    const thread = engine.store.findThread(args.threadId);
    if (!thread) {
      console.error(`No council thread found for "${args.threadId}".`);
      return 1;
    }
    threadId = thread.id;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  const progress = args.json ? undefined : new Progress();
  if (progress) {
    console.log(
      dim(`Asking ${members.map(seatName).join(', ')} · merged by ${seatName(synthesizer)}\n`),
    );
  }

  try {
    const result = await engine.council.ask(args.question, {
      members,
      synthesizer,
      signal: controller.signal,
      ...(threadId && { threadId }),
      ...(progress && { onEvent: (u: CouncilUpdate) => progress.update(u) }),
    });

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            threadId: result.thread.id,
            mergedBy: result.mergedBy,
            merged: result.merged,
            answers: result.answers.map((a) => ({ label: a.label, ...a.message })),
          },
          null,
          2,
        ),
      );
      return result.merged.ok ? 0 : 1;
    }

    console.log('');
    for (const a of result.answers) {
      console.log(heading(a.label));
      console.log(a.message.ok ? a.message.content : paint('red', `Failed: ${a.message.error}`));
      console.log(dim(stats(a.message.durationMs, a.message.usage)) + '\n');
    }
    const by =
      result.mergedBy === 'synthesizer'
        ? `merged by ${seatName(synthesizer)}`
        : result.mergedBy === 'single-answer'
          ? 'only one member answered'
          : 'nobody answered';
    console.log(heading(`Council answer · ${by}`));
    console.log(
      result.merged.ok ? result.merged.content : paint('red', result.merged.error ?? 'Failed'),
    );
    console.log(
      dim(
        `\nthread ${shortId(result.thread.id)} · follow up with: conclave ask --thread ${shortId(result.thread.id)} "..."`,
      ),
    );
    return result.merged.ok ? 0 : 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/** One status line per council seat, printed as each finishes. */
class Progress {
  private readonly started = new Set<string>();

  update(u: CouncilUpdate): void {
    const key = u.phase === 'member' ? `m${u.index}` : 'synth';
    const name = u.phase === 'member' ? u.label : `Merging answers (${seatName(u.seat)})`;
    if (!this.started.has(key) && u.event.type === 'session') {
      this.started.add(key);
      console.log(dim(`  … ${name} is thinking`));
    }
    if (u.event.type === 'done') {
      const mark = u.event.ok ? paint('green', '✓') : paint('red', '✗');
      console.log(`  ${mark} ${bold(name)} ${dim(`${(u.event.durationMs / 1000).toFixed(1)}s`)}`);
    }
  }
}

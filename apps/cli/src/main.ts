#!/usr/bin/env node
import './quiet.js';
import { parseArgs } from 'node:util';
import { Engine, VERSION, parseSeat } from '@conclave/core';
import { askCommand } from './ask.js';
import { chatCommand } from './chat.js';
import { projectCommand } from './project.js';
import { doctor } from './doctor.js';
import { showCommand, threadsCommand } from './threads.js';

const HELP = `conclave ${VERSION}

Usage: conclave <command> [options]

Commands:
  doctor                 Check which AI CLIs are installed and signed in
      --live             also send each signed-in provider a tiny test prompt
  chat [message]         Chat with one model; interactive when no message is given
      --use <p[:m][@e]>  who answers, e.g. claude, codex@low, claude:opus@high
      --thread <id>      continue an earlier chat
  ask <question>         Ask every signed-in model at once and merge the answers
      --with <p,p:m@e>   council members (default: every signed-in provider)
      --synth <p[:m][@e]>  who merges the answers (default: Claude)
      --thread <id>      follow up on an earlier council
  threads                List recent chats and councils
  show <id>              Print a chat or council
  project new <repo>     Set up an autonomous project on a git repo
      --goal "..."       what it should achieve (required)
      --test "cmd"       command that must pass after every task, e.g. "npm test"
      --done "..."       how to tell the goal is met
      --planner/--builder/--reviewer <p[:m][@e],...>  who does each job, in order
  project run <id>       Work on it until the goal is met (Ctrl+C stops after the step)
  project status <id>    Tasks, approvals and recent activity
  project list | stop <id>
  project retry <task>   Requeue a failed task (--use claude:opus@high, --effort-up)
  project skip <task>    Leave a task out

Options:
  --json         Machine-readable output (doctor, ask)
  -h, --help     Show this help
  -v, --version  Show the version

Data lives in ~/.conclave (override with CONCLAVE_HOME).
`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      live: { type: 'boolean' },
      json: { type: 'boolean' },
      use: { type: 'string' },
      thread: { type: 'string' },
      with: { type: 'string' },
      synth: { type: 'string' },
      goal: { type: 'string' },
      test: { type: 'string' },
      done: { type: 'string' },
      planner: { type: 'string' },
      builder: { type: 'string' },
      reviewer: { type: 'string' },
      attempts: { type: 'string' },
      rounds: { type: 'string' },
      'effort-up': { type: 'boolean' },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, ...rest] = positionals;
  const text = rest.join(' ').trim();
  if (!command || values.help) {
    console.log(HELP);
    return 0;
  }

  if (command === 'doctor')
    return doctor({ live: values.live === true, json: values.json === true });

  const engine = new Engine();
  try {
    switch (command) {
      case 'chat':
        return await chatCommand(engine, {
          ...(text && { message: text }),
          ...(values.use && { seat: parseSeat(values.use) }),
          ...(values.thread && { threadId: values.thread }),
        });
      case 'ask':
        if (!text) {
          console.error('Usage: conclave ask "your question"');
          return 1;
        }
        return await askCommand(engine, {
          question: text,
          json: values.json === true,
          ...(values.with && { members: values.with.split(',').map(parseSeat) }),
          ...(values.synth && { synthesizer: parseSeat(values.synth) }),
          ...(values.thread && { threadId: values.thread }),
        });
      case 'project':
      case 'projects':
        return await projectCommand(engine, {
          sub: command === 'projects' ? 'list' : rest[0],
          rest: rest.slice(1),
          ...(values.goal && { goal: values.goal }),
          ...(values.test && { test: values.test }),
          ...(values.done && { done: values.done }),
          ...(values.planner && { planner: values.planner }),
          ...(values.builder && { builder: values.builder }),
          ...(values.reviewer && { reviewer: values.reviewer }),
          ...(values.attempts && { attempts: values.attempts }),
          ...(values.rounds && { rounds: values.rounds }),
          ...(values.use && { use: values.use }),
          ...(values['effort-up'] && { effortUp: true }),
        });
      case 'threads':
        return threadsCommand(engine);
      case 'show':
        return showCommand(engine, rest[0]);
      default:
        console.error(`Unknown or not-yet-built command: ${command}\n`);
        console.log(HELP);
        return 1;
    }
  } finally {
    engine.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}

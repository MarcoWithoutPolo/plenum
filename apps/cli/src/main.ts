#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { VERSION } from '@conclave/core';
import { doctor } from './doctor.js';

const HELP = `conclave ${VERSION}

Usage: conclave <command> [options]

Commands:
  doctor     Check which AI CLIs are installed and signed in
             --live  also send each signed-in provider a tiny test prompt
             --json  machine-readable output
  chat       Chat with one model from the terminal              (M2)
  ask        Ask every model at once and merge the answers      (M2)
  project    Run the autonomous brain on a repo                 (M4)
  daemon     Run the engine in the background                   (M4)

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      live: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const [command] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case 'doctor':
      return doctor({ live: values.live === true, json: values.json === true });
    default:
      console.error(`Unknown or not-yet-built command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));

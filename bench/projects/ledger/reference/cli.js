#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const { LedgerError, parseLedger, balances, register, formatAmount } = require('./index');

const USAGE = 'usage: node cli.js <balance|register> <file> [--depth N | query terms...]';

function main(argv) {
  const [command, file, ...rest] = argv;
  if (!['balance', 'register'].includes(command) || !file) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const journal = parseLedger(readFileSync(file, 'utf8'));
    if (command === 'balance') {
      const at = rest.indexOf('--depth');
      const depth = at >= 0 ? Number(rest[at + 1]) : undefined;
      for (const r of balances(journal, { depth })) {
        const amount = formatAmount({ cents: r.cents, currency: r.currency });
        process.stdout.write(`${r.account}  ${amount}\n`);
      }
    } else {
      for (const r of register(journal, rest.join(' '))) {
        const running = formatAmount({ cents: r.running, currency: r.amount.currency });
        process.stdout.write(
          `${r.date}  ${r.memo}  ${r.account}  ${formatAmount(r.amount)}  ${running}\n`,
        );
      }
    }
    return 0;
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    const where = err.line !== undefined ? ` (line ${err.line})` : '';
    process.stderr.write(`error: ${err.message}${where}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));

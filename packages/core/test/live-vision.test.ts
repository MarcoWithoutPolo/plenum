import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  AntigravityAdapter,
  ClaudeAdapter,
  CodexAdapter,
  collect,
  type Adapter,
} from '../src/index.js';

// Live scenario 14 (v0.8): can each CLI really look at a screenshot? One image, two colours
// nobody would guess (left half orange, right half teal), and a question only sight answers.
// Spends real usage, so it only runs when asked: PLENUM_LIVE=1 npx vitest run live-vision
const enabled = process.env.PLENUM_LIVE === '1';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A 320×160 PNG: orange on the left, teal on the right (or the other way round). */
function twoColours(swap = false): Buffer {
  const w = 320;
  const h = 160;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const [r, g, b] = x < w / 2 !== swap ? [255, 140, 0] : [0, 128, 128];
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Antigravity runs twice, the second time with the halves swapped, so a pass isn't a guess.
const cases: [Adapter, string | undefined, boolean][] = [
  [new ClaudeAdapter(), 'haiku', false],
  [new CodexAdapter(), undefined, false],
  [new AntigravityAdapter(), undefined, false],
  [new AntigravityAdapter(), undefined, true],
];

describe.skipIf(!enabled)('live: reading a screenshot', () => {
  for (const [adapter, model, swap] of cases) {
    it(
      `${adapter.displayName} (vision: ${adapter.capabilities.vision ?? 'none'})${swap ? ', halves swapped' : ''}`,
      { timeout: 300_000 },
      async (ctx) => {
        const status = await adapter.detect();
        if (status.auth !== 'signed_in') ctx.skip();
        // As in a review: the screenshot sits outside the working folder, passed as an image.
        const dir = mkdtempSync(join(tmpdir(), 'plenum-vision-cwd-'));
        const file = join(mkdtempSync(join(tmpdir(), 'plenum-vision-shots-')), 'shot.png');
        writeFileSync(file, twoColours(swap));
        // Attached when the CLI takes images; otherwise named, to open with its own tools.
        const native = adapter.capabilities.vision === 'native';
        const result = await collect(
          adapter.run({
            prompt: `${native ? 'Look at the attached image' : `Open the image file ${file} with your file-reading tool and look at it`}. It has two halves of different colours. Reply with exactly one line: "left: <colour>, right: <colour>", using plain colour names.`,
            cwd: dir,
            role: 'reviewer',
            readOnly: true,
            ...(model && { model }),
            images: [file],
          }),
        );
        console.log(
          `${adapter.displayName}: ${result.ok ? result.text.trim() : result.errors.join(' ')}`,
        );
        expect(result.ok).toBe(true);
        const text = result.text.toLowerCase();
        const orange = '(orange|amber)';
        const teal = '(teal|turquoise|cyan|blue-green|green)';
        expect(text).toMatch(new RegExp(`left:\\s*${swap ? teal : orange}`));
        expect(text).toMatch(new RegExp(`right:\\s*${swap ? orange : teal}`));
      },
    );
  }
});

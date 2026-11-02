// Shared helpers for the hidden recipes checks: start and stop `node server.js`, and call its API.
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const net = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const tempDirs = [];
const tempDataFile = (name = 'recipes.db') => {
  const dir = mkdtempSync(join(tmpdir(), 'recipes-hidden-'));
  tempDirs.push(dir);
  return join(dir, name);
};
/** Remove the temp data folders (after every server is stopped). */
const cleanup = () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
};

/** Start `node server.js` in the project folder; resolves once GET /api/recipes answers. */
async function startServer(dataFile) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  let exited = false;
  child.on('exit', () => (exited = true));
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (exited) throw new Error(`server.js exited before it was ready:\n${output.slice(-2000)}`);
    try {
      const r = await fetch(`${base}/api/recipes`);
      await r.arrayBuffer();
      if (r.status === 200) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(
        `server.js did not answer GET /api/recipes within 15 s:\n${output.slice(-2000)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    port,
    child,
    stop: () =>
      new Promise((resolve) => {
        if (exited || child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

/** Call the API: returns { status, type, body } with body parsed as JSON when it is JSON. */
async function call(base, method, path, body, raw = false) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed = buf;
  if (/json/.test(type) || (buf.length && /^[\s[{"]/.test(buf.toString('utf8', 0, 1)))) {
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      parsed = buf.toString('utf8');
    }
  }
  return { status: res.status, type, body: parsed, bytes: buf };
}

// A real 1×1 PNG, so a browser can draw it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
// The start of a JPEG file (SOI + JFIF header) and some bytes: enough for the API.
const JPEG = Buffer.concat([
  Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'),
  Buffer.alloc(64, 7),
  Buffer.from('ffd9', 'hex'),
]);
const dataUrl = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;

module.exports = { startServer, tempDataFile, cleanup, call, PNG, JPEG, dataUrl };

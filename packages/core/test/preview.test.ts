import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Agent, request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrainManager,
  PreviewServer,
  Store,
  adapterMap,
  createProject,
  detectPreview,
  findLocalUrl,
  projectWorkspace,
  reachableUrl,
  removeDir,
  worktreeReady,
} from '../src/index.js';

const dirs: string[] = [];
const servers: PreviewServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  // Windows can hold a stopped dev server's folder for a few seconds after taskkill returns.
  for (const d of dirs.splice(0)) await removeDir(d, 20);
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-preview-'));
  dirs.push(dir);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const pkg = (extra: object) => JSON.stringify({ name: 'x', ...extra });

function raw(url: string, path: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(url);
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

describe('Preview detection', () => {
  it('serves a folder with an index.html as a static site, wherever it sits', () => {
    expect(detectPreview(folder({ 'index.html': '<h1>hi</h1>' }))).toMatchObject({
      kind: 'static',
    });
    const pub = folder({ 'public/index.html': '<h1>hi</h1>' });
    expect(detectPreview(pub)).toEqual({ kind: 'static', root: join(pub, 'public') });
  });

  it("runs a web app's dev server, preferring dev over start", () => {
    const vite = folder({
      'package.json': pkg({
        scripts: { start: 'vite preview', dev: 'vite' },
        devDependencies: { vite: '7' },
      }),
    });
    expect(detectPreview(vite)).toEqual({
      kind: 'command',
      command: 'npm run dev',
      runs: 'vite',
      readyTimeoutMs: 60_000,
    });
    // What it runs includes its pre-script, which npm runs first.
    const prepped = folder({
      'package.json': pkg({
        scripts: { predev: 'node prep.js', dev: 'vite' },
        devDependencies: { vite: '7' },
      }),
    });
    expect(detectPreview(prepped)).toMatchObject({ runs: 'node prep.js && vite' });
    const next = folder({
      'package.json': pkg({ scripts: { start: 'next start' } }),
      'next.config.mjs': '',
    });
    expect(detectPreview(next)).toMatchObject({ kind: 'command', command: 'npm run start' });
    // A static page with a server script of its own: the script runs it.
    const served = folder({
      'index.html': '',
      'package.json': pkg({ scripts: { start: 'node server.js' } }),
    });
    expect(detectPreview(served)).toMatchObject({ kind: 'command', command: 'npm run start' });
  });

  it('never mistakes a CLI package for a web app', () => {
    const cli = folder({
      'package.json': pkg({ scripts: { start: 'node cli.js', test: 'node --test' } }),
      'cli.js': '',
    });
    expect(detectPreview(cli)).toEqual({
      kind: 'none',
      reason: 'No web page here: no index.html, and no web framework.',
    });
    const noScript = folder({ 'package.json': pkg({ dependencies: { next: '15' } }) });
    expect(detectPreview(noScript)).toMatchObject({
      kind: 'none',
      reason: expect.stringMatching(/no dev or start script/),
    });
  });

  it('finds the address a dev server prints, made safe to open', () => {
    expect(
      findLocalUrl('\x1b[32m  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'),
    ).toBe('http://127.0.0.1:5173/');
    expect(findLocalUrl('  - Local:        http://localhost:3000')).toBe('http://127.0.0.1:3000/');
    expect(findLocalUrl('Listening on http://0.0.0.0:8080/app')).toBe('http://127.0.0.1:8080/app');
    expect(findLocalUrl('see https://vitejs.dev for docs')).toBeUndefined();
  });

  it('opens a server that only listens on IPv6 as localhost', async () => {
    const { createServer } = await import('node:net');
    const v6 = createServer((c) => c.end());
    const port = await new Promise<number>((ok, fail) => {
      v6.once('error', fail);
      v6.listen(0, '::1', () => ok((v6.address() as { port: number }).port));
    }).catch(() => undefined);
    if (!port) return; // no IPv6 loopback on this machine
    try {
      expect(await reachableUrl(`http://127.0.0.1:${port}/`)).toBe(`http://localhost:${port}/`);
    } finally {
      v6.close();
    }
    const v4 = createServer((c) => c.end());
    const port4 = await new Promise<number>((ok) =>
      v4.listen(0, '127.0.0.1', () => ok((v4.address() as { port: number }).port)),
    );
    try {
      expect(await reachableUrl(`http://127.0.0.1:${port4}/x`)).toBe(`http://127.0.0.1:${port4}/x`);
    } finally {
      v4.close();
    }
  });
});

describe('Static preview server', () => {
  it('serves the files on 127.0.0.1 and nothing outside the folder', async () => {
    const root = folder({
      'site/index.html': '<h1>Home</h1>',
      'site/app.js': 'export {}',
      'secret.txt': 'no',
    });
    const server = new PreviewServer(join(root, 'site'), {
      kind: 'static',
      root: join(root, 'site'),
    });
    servers.push(server);
    const { url } = await server.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const home = await fetch(url);
    expect([home.status, await home.text()]).toEqual([200, '<h1>Home</h1>']);
    const js = await fetch(`${url}app.js`);
    expect(js.headers.get('content-type')).toMatch(/text\/javascript/);
    expect((await fetch(`${url}missing.css`)).status).toBe(404);
    // Sent raw (fetch would normalize the path first): nothing outside the folder is served.
    for (const path of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/../secret.txt']) {
      const { status, body } = await raw(url, path);
      expect([status, body.includes('no')]).toEqual([403, false]);
    }
    await server.stop();
    await expect(fetch(url)).rejects.toThrow();
  });

  it('stops at once while a page still holds a connection open (the preview pane)', async () => {
    const root = folder({ 'site/index.html': '<h1>Home</h1>' });
    const server = new PreviewServer(join(root, 'site'), {
      kind: 'static',
      root: join(root, 'site'),
    });
    servers.push(server);
    const { url } = await server.start();
    // A keep-alive connection, as the preview's iframe keeps one.
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((ok) =>
      request(url, { agent }, (res) => {
        res.resume();
        res.on('end', () => ok());
      }).end(),
    );
    const stopped = await Promise.race([
      server.stop().then(() => 'stopped'),
      new Promise((ok) => setTimeout(() => ok('still waiting'), 3000)),
    ]);
    agent.destroy();
    expect(stopped).toBe('stopped');
  });
});

describe('Dev-server preview', () => {
  const devServer = `
const http = require('http');
const port = Number(process.env.PORT);
http.createServer((q, s) => s.end('dev page')).listen(port, '127.0.0.1', () => {
  console.log('  ready in 12 ms');
  console.log('  Local:   http://localhost:' + port + '/');
});`;

  it('starts the command, finds its address, and stops the whole server', async () => {
    const dir = folder({ 'server.js': devServer });
    const server = new PreviewServer(dir, {
      kind: 'command',
      command: 'node server.js',
      runs: 'node server.js',
      readyTimeoutMs: 20_000,
    });
    servers.push(server);
    const { url } = await server.start();
    expect(await (await fetch(url)).text()).toBe('dev page');
    expect(server.logs()).toContain('ready in 12 ms');
    await server.stop();
    await new Promise((r) => setTimeout(r, 500));
    await expect(fetch(url)).rejects.toThrow();
  });

  it('gives up with the output when no address appears, and when the server exits early', async () => {
    const quiet = folder({
      'server.js': "console.log('compiling…'); setInterval(() => {}, 1000);",
    });
    const slow = new PreviewServer(quiet, {
      kind: 'command',
      command: 'node server.js',
      runs: 'node server.js',
      readyTimeoutMs: 1500,
    });
    servers.push(slow);
    await expect(slow.start()).rejects.toThrow(
      /didn't print a local address within 2 s\.\ncompiling…/,
    );
    const broken = folder({
      'server.js': "console.error('Cannot find module vite'); process.exit(1);",
    });
    const crash = new PreviewServer(broken, {
      kind: 'command',
      command: 'node server.js',
      runs: 'node server.js',
      readyTimeoutMs: 20_000,
    });
    servers.push(crash);
    await expect(crash.start()).rejects.toThrow(
      /stopped \(exit 1\) before it was ready\.\nCannot find module vite/,
    );
  });
});

describe('BrainManager.preview', () => {
  function repo(files: Record<string, string>): string {
    const dir = folder(files);
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], {
        cwd: dir,
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return dir;
  }

  async function manager(files: Record<string, string>) {
    const home = folder({});
    const store = new Store(':memory:');
    const project = await createProject(store, [{ provider: 'claude' }], {
      repoPath: repo(files),
      goal: 'g',
    });
    const brains = new BrainManager({ store, adapters: adapterMap([]), cwd: home }, home);
    return { store, project, brains, home };
  }

  it('opens a static site at once, and stops it', async () => {
    const { project, brains } = await manager({ 'index.html': '<h1>Board</h1>' });
    const result = await brains.preview(project.id);
    expect(result).toMatchObject({ kind: 'ready', static: true });
    if (result.kind !== 'ready') return;
    expect(await (await fetch(result.url)).text()).toBe('<h1>Board</h1>');
    await brains.stopPreviews();
    await expect(fetch(result.url)).rejects.toThrow();
  });

  it('asks before running a dev server, then remembers your decision', async () => {
    const { store, project, brains } = await manager({
      'index.html': '',
      'server.js': `require('http').createServer((q, s) => s.end('ok')).listen(+process.env.PORT, '127.0.0.1', () => console.log('http://localhost:' + process.env.PORT));`,
      'package.json': pkg({ scripts: { dev: 'node server.js' } }),
    });
    expect(await brains.preview(project.id)).toEqual({
      kind: 'needs_approval',
      command: 'npm run dev',
      runs: 'node server.js',
    });
    brains.allowPreviewCommand(project.id, 'npm run dev');
    expect(store.projects.get(project.id)?.previewCommand).toBe('npm run dev → node server.js');
    expect(store.decisions.list(project.id).map((d) => d.answer)).toEqual([
      'npm run dev → node server.js',
    ]);
    const result = await brains.preview(project.id);
    expect(result).toMatchObject({ kind: 'ready', static: false });
    if (result.kind === 'ready') expect(await (await fetch(result.url)).text()).toBe('ok');
    await brains.stopPreviews();

    // Same script name, different code (an agent edited package.json): it asks again.
    writeFileSync(
      join(project.repoPath, 'package.json'),
      pkg({ scripts: { dev: 'node server.js --other' } }),
    );
    expect(await brains.preview(project.id)).toEqual({
      kind: 'needs_approval',
      command: 'npm run dev',
      runs: 'node server.js --other',
    });
    // Only what's detected now can be allowed.
    expect(() => brains.allowPreviewCommand(project.id, 'npm run start')).toThrow(
      /no longer matches/,
    );
  });

  it('ignores a merged-work worktree that is still being checked out', async () => {
    // On a slow machine `git worktree add` makes the folder first and fills it afterwards. A
    // preview opened then asked about your folder and checked the approval against the half-made
    // one (no package.json yet), so Allow failed with "no longer matches".
    const { project, brains, home } = await manager({
      'index.html': '',
      'server.js': '',
      'package.json': pkg({ scripts: { dev: 'node server.js' } }),
    });
    const workspace = projectWorkspace(home, project);
    await workspace.prepare(project.baseBranch);
    expect(worktreeReady(workspace.integrationPath)).toBe(true);

    // Mid-checkout: git's "initializing" lock is still there and the files aren't yet.
    const admin = readFileSync(join(workspace.integrationPath, '.git'), 'utf8')
      .replace(/^gitdir:\s*/, '')
      .trim();
    writeFileSync(join(admin, 'locked'), 'initializing');
    rmSync(join(workspace.integrationPath, 'package.json'));
    expect(worktreeReady(workspace.integrationPath)).toBe(false);

    expect(await brains.preview(project.id)).toMatchObject({
      kind: 'needs_approval',
      command: 'npm run dev',
    });
    expect(() => brains.allowPreviewCommand(project.id, 'npm run dev')).not.toThrow();

    // The next run starts that checkout again instead of keeping a broken one.
    await workspace.prepare(project.baseBranch);
    expect(worktreeReady(workspace.integrationPath)).toBe(true);
    expect(existsSync(join(workspace.integrationPath, 'package.json'))).toBe(true);
  });

  it('says plainly when there is nothing to preview', async () => {
    const { project, brains } = await manager({
      'cli.js': '',
      'package.json': pkg({ scripts: { start: 'node cli.js' } }),
    });
    expect(await brains.preview(project.id)).toMatchObject({ kind: 'none' });
  });
});

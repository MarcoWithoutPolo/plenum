import { spawn, type ChildProcess } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { killTree } from '../process.js';

/** What a live preview of a folder would run. */
export type PreviewPlan =
  | { kind: 'static'; root: string }
  /** `runs`: what npm runs for it, from package.json (its pre-script too). */
  | { kind: 'command'; command: string; runs: string; readyTimeoutMs: number }
  | { kind: 'none'; reason: string };

/**
 * What you allow for a project's previews: the command and what it runs. Bound to the script's
 * text, so an agent editing package.json can't change what runs without asking you again.
 */
export function previewApproval(plan: Extract<PreviewPlan, { kind: 'command' }>): string {
  return `${plan.command} → ${plan.runs}`;
}

/** Whether `previewCommand` (a project's stored approval) allows this plan. */
export function previewAllowed(previewCommand: string | null, plan: PreviewPlan): boolean {
  return plan.kind === 'command' && previewCommand === previewApproval(plan);
}

const FRAMEWORK_DEPS = [
  'vite',
  'next',
  'astro',
  'nuxt',
  '@sveltejs/kit',
  'react-scripts',
  'parcel',
  'webpack-dev-server',
  '@remix-run/dev',
  '@angular/cli',
];
const FRAMEWORK_CONFIGS = /^(vite|next|astro|svelte|nuxt|remix)\.config\.(js|cjs|mjs|ts|mts)$/;
const STATIC_ROOTS = ['', 'public', 'dist', 'build', 'src'];

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Work out how to preview `dir`, from its files alone. A dev server needs real evidence of a
 * web app (a framework dependency or config, or an index.html), so a CLI package with a
 * "start" script is never mistaken for one. Otherwise a folder with an index.html is static.
 */
export function detectPreview(dir: string): PreviewPlan {
  const pkg = readJson(join(dir, 'package.json'));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) };
  const framework =
    FRAMEWORK_DEPS.some((d) => d in deps) ||
    (existsSync(dir) &&
      (readDirSafe(dir).some((f) => FRAMEWORK_CONFIGS.test(f)) ||
        existsSync(join(dir, 'angular.json'))));
  const html = STATIC_ROOTS.find((r) => existsSync(join(dir, r, 'index.html')));
  const script = ['dev', 'start', 'preview'].find((s) => typeof scripts[s] === 'string');
  if (script && (framework || html !== undefined)) {
    const runs = [scripts[`pre${script}`], scripts[script]]
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .join(' && ');
    return { kind: 'command', command: `npm run ${script}`, runs, readyTimeoutMs: 60_000 };
  }
  if (html !== undefined) return { kind: 'static', root: join(dir, html) };
  if (framework) {
    return {
      kind: 'none',
      reason: 'This looks like a web app, but package.json has no dev or start script.',
    };
  }
  return { kind: 'none', reason: 'No web page here: no index.html, and no web framework.' };
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

const URL_IN_OUTPUT =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{2,5})(\/[^\s'"\x1b)]*)?/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The first local URL a dev server printed, made safe to open (0.0.0.0 becomes 127.0.0.1). */
export function findLocalUrl(output: string): string | undefined {
  const m = URL_IN_OUTPUT.exec(output.replace(ANSI, ''));
  return m ? `http://127.0.0.1:${m[1]}${m[2] ?? '/'}` : undefined;
}

/**
 * A live preview of one folder. Static previews are served by Conclave itself on 127.0.0.1 and run
 * no project code. Command previews run the project's own dev server, which you allowed first.
 */
export class PreviewServer {
  private http: Server | undefined;
  private child: ChildProcess | undefined;
  private output = '';
  private url: string | undefined;
  lastUsed = Date.now();

  constructor(
    readonly dir: string,
    readonly plan: PreviewPlan,
    private readonly opts: { env?: Record<string, string>; signal?: AbortSignal } = {},
  ) {}

  get running(): boolean {
    return Boolean(this.url) && (Boolean(this.http) || (this.child?.exitCode ?? null) === null);
  }

  /** The server's recent output, newest last (command previews). */
  logs(): string {
    return this.output.replace(ANSI, '').split('\n').slice(-200).join('\n');
  }

  async start(): Promise<{ url: string }> {
    this.lastUsed = Date.now();
    if (this.url && this.running) return { url: this.url };
    if (this.plan.kind === 'none') throw new Error(this.plan.reason);
    if (this.plan.kind === 'static') return this.startStatic(this.plan.root);
    return this.startCommand(this.plan.command, this.plan.readyTimeoutMs);
  }

  private startStatic(root: string): Promise<{ url: string }> {
    const base = realpathSync.native(resolve(root));
    const server = createHttpServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
      let path: string;
      try {
        path = decodeURIComponent((req.url ?? '/').split('?')[0]!.split('#')[0]!);
      } catch {
        return void res.writeHead(400).end();
      }
      let file = resolve(base, `.${path}`);
      if (file !== base && !file.startsWith(base + sep)) return void res.writeHead(403).end();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile())
        return void res.writeHead(404).end('Not found');
      // Never serve outside the folder through a link.
      const real = realpathSync.native(file);
      if (real !== base && !real.startsWith(base + sep)) return void res.writeHead(403).end();
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file).pipe(res);
    });
    return new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        this.http = server;
        this.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
        ok({ url: this.url });
      });
    });
  }

  private async startCommand(command: string, readyTimeoutMs: number): Promise<{ url: string }> {
    const port = await freePort();
    const child = spawn(command, {
      cwd: this.dir,
      shell: true,
      windowsHide: true,
      // Its own process group on macOS and Linux, so stop() takes the whole server down.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...this.opts.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        BROWSER: 'none',
        FORCE_COLOR: '0',
      },
    });
    this.child = child;
    return new Promise((ok, fail) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opts.signal?.removeEventListener('abort', onAbort);
        // Never report a failure while the server is still running (and holding the folder).
        if (err) void this.stop().finally(() => fail(err));
        else ok({ url: this.url! });
      };
      const onData = (chunk: Buffer) => {
        this.output = (this.output + chunk.toString('utf8')).slice(-20_000);
        if (!this.url) {
          const url = findLocalUrl(this.output);
          if (url) {
            this.url = url;
            done();
          }
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => done(new Error(`${command} couldn't start: ${err.message}`)));
      child.on('exit', (code) => {
        if (!this.url)
          done(new Error(`${command} stopped (exit ${code}) before it was ready.\n${this.logs()}`));
      });
      const timer = setTimeout(
        () =>
          done(
            new Error(
              `${command} didn't print a local address within ${Math.round(readyTimeoutMs / 1000)} s.\n${this.logs()}`,
            ),
          ),
        readyTimeoutMs,
      );
      const onAbort = () => done(new Error('Stopped'));
      this.opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Stop the preview; a dev server's whole process tree goes with it. */
  async stop(): Promise<void> {
    this.url = undefined;
    const http = this.http;
    this.http = undefined;
    if (http) await new Promise<void>((r) => http.close(() => r()));
    const child = this.child;
    this.child = undefined;
    if (child) await killTree(child);
  }
}

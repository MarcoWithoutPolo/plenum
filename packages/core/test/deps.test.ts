import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Workspace } from '../src/workspace/git.js';
import {
  depsInstalled,
  depsPlan,
  installDeps,
  linkDeps,
  releaseDeps,
} from '../src/workspace/deps.js';

const root = mkdtempSync(join(tmpdir(), 'plenum-deps-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd });

/** A repository whose package depends on a local package, so installing needs no network. */
function project(name: string): string {
  const repo = join(root, name);
  mkdirSync(join(repo, 'vendor', 'tiny'), { recursive: true });
  writeFileSync(
    join(repo, 'vendor', 'tiny', 'package.json'),
    '{ "name": "tiny", "version": "1.0.0", "main": "index.js" }\n',
  );
  writeFileSync(join(repo, 'vendor', 'tiny', 'index.js'), 'module.exports = 42;\n');
  writeFileSync(
    join(repo, 'package.json'),
    '{ "name": "site", "private": true, "dependencies": { "tiny": "file:./vendor/tiny" } }\n',
  );
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

describe('packages in Plenum’s own folders (1.0.1)', () => {
  it('knows what installing takes, and when the dependencies changed', () => {
    const dir = join(root, 'plans');
    mkdirSync(dir);
    expect(depsPlan(dir)).toBeNull();
    writeFileSync(join(dir, 'package.json'), '{ "name": "x", "scripts": { "dev": "vite" } }');
    expect(depsPlan(dir)).toBeNull();
    writeFileSync(join(dir, 'package.json'), '{ "devDependencies": { "vite": "^7.0.0" } }');
    expect(depsPlan(dir)?.command).toBe('npm install --no-package-lock --no-audit --no-fund');
    writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3 }');
    const first = depsPlan(dir)!;
    expect(first.command).toBe('npm ci');
    writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, "x": 1 }');
    expect(depsPlan(dir)!.key).not.toBe(first.key);
  });

  it('installs once, links task folders to it, and removing a task never empties it', async () => {
    const repo = project('site');
    const ws = new Workspace(repo, join(root, 'ws'), 'plenum/integration');
    await ws.prepare('main');
    const integration = ws.integrationPath;
    const plan = depsPlan(integration)!;
    expect(depsInstalled(integration, plan)).toBe(false);
    const ran = await installDeps(integration, plan);
    expect(ran.ok).toBe(true);
    expect(depsInstalled(integration, plan)).toBe(true);
    // Nothing was written into the folder git tracks.
    expect(existsSync(join(integration, 'package-lock.json'))).toBe(false);

    const tree = await ws.createTaskTree('t1');
    expect(await linkDeps(tree, integration)).toBe(true);
    expect(lstatSync(join(tree, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(tree, 'node_modules', 'tiny', 'index.js'))).toBe(true);
    // The task's commit never picks the link up.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: tree }).toString()).toBe('');

    await ws.removeTaskTree('t1');
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(join(integration, 'node_modules', 'tiny', 'index.js'))).toBe(true);
    await ws.dispose();
  }, 120_000);

  it('a task that changed its dependencies gets no link', async () => {
    const repo = project('changed');
    const ws = new Workspace(repo, join(root, 'ws2'), 'plenum/integration');
    await ws.prepare('main');
    await installDeps(ws.integrationPath, depsPlan(ws.integrationPath)!);
    const tree = await ws.createTaskTree('t2');
    writeFileSync(
      join(tree, 'package.json'),
      '{ "name": "site", "dependencies": { "tiny": "file:./vendor/tiny", "other": "1.0.0" } }\n',
    );
    expect(await linkDeps(tree, ws.integrationPath)).toBe(false);
    expect(existsSync(join(tree, 'node_modules'))).toBe(false);
    await ws.dispose();
  }, 120_000);

  it('never links where git would commit node_modules', async () => {
    const repo = project('unignored');
    rmSync(join(repo, '.gitignore'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'no ignore');
    const ws = new Workspace(repo, join(root, 'ws3'), 'plenum/integration');
    await ws.prepare('main');
    await installDeps(ws.integrationPath, depsPlan(ws.integrationPath)!);
    const tree = await ws.createTaskTree('t3');
    expect(await linkDeps(tree, ws.integrationPath)).toBe(false);
    releaseDeps(ws.integrationPath);
    expect(existsSync(join(ws.integrationPath, 'node_modules', 'tiny'))).toBe(true);
    await ws.dispose();
  }, 120_000);
});

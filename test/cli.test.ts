import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'bin/repo-queue');
function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
}
function object(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test('CLI registers an original conversation and rejects unsupported options without adding work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-cli-'));
  try {
    const state = join(directory, 'state');
    const task = randomUUID();
    const args = ['--state', state, 'add', 'https://github.com/example/project/pull/8', '--agent', 'codex', '--task', task, '--cwd', directory];
    const added = run(args);
    assert.equal(added.status, 0, added.stderr);
    const entry = object(added.stdout);
    assert.equal(entry.task, task);
    assert.equal(entry.cwd, realpathSync(directory));
    assert.equal(entry.state, 'waiting');
    const duplicate = run(args);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(object(duplicate.stdout).id, entry.id);
    const invalid = run([...args, '--reason', 'not an add option']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /not supported/);
    const status = run(['--state', state, 'status']);
    assert.equal(status.status, 0, status.stderr);
    const entries = object(status.stdout).entries;
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI refuses recovery without a quiescence assertion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-recover-'));
  try {
    const result = run(['--state', directory, 'recover', randomUUID(), '--token', 'token']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --quiescent/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('packed command installs without runtime dependencies or its source checkout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-package-'));
  try {
    const npm = process.env.npm_execpath;
    assert.ok(npm, 'Run package tests with npm test');
    const packed = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory],
      { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(packed.status, 0, packed.stderr);
    const parsed: unknown = JSON.parse(packed.stdout);
    assert.ok(Array.isArray(parsed));
    const pack = parsed[0] as unknown;
    assert.ok(typeof pack === 'object' && pack !== null && 'filename' in pack && typeof pack.filename === 'string');
    assert.ok('files' in pack && Array.isArray(pack.files));
    for (const value of pack.files as unknown[]) {
      assert.ok(typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string');
      assert.doesNotMatch(value.path, /node_modules|\.sqlite3|\.log$|repo_queue\/|test\//);
    }
    const prefix = join(directory, 'prefix');
    const installed = spawnSync(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(directory, pack.filename)],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(installed.status, 0, installed.stderr);
    const result = spawnSync(process.execPath, [join(prefix, 'bin/repo-queue'), '--version'], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^RepoQ 0\.1\.0/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

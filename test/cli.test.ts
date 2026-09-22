import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { wakeMessage } from '../src/dispatcher.ts';
import { DeliveryLedger } from '../src/delivery-ledger.ts';
import { Store } from '../src/store.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'bin/repo-queue');
const cliEnvironment = { ...process.env };
delete cliEnvironment.CODEX_THREAD_ID;
delete cliEnvironment.CODEX_SESSION_ID;
function run(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { ...cliEnvironment, ...environment },
  });
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

test('CLI rejects Codex collaboration workers before registration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-codex-owner-'));
  try {
    const state = join(directory, 'state');
    const rootTask = randomUUID();
    const result = run([
      '--state', state, 'add', 'https://github.com/example/project/pull/9',
      '--agent', 'codex', '--task', rootTask, '--cwd', directory,
    ], {
      CODEX_THREAD_ID: rootTask,
      CODEX_SESSION_ID: randomUUID(),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /collaboration sub-agents cannot receive RepoQ wakes/);

    const status = run(['--state', state, 'status']);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(object(status.stdout).entries, []);

    const claude = run([
      '--state', state, 'add', 'https://github.com/example/project/pull/11',
      '--agent', 'claude', '--task', rootTask, '--cwd', directory,
    ], {
      CODEX_THREAD_ID: rootTask,
      CODEX_SESSION_ID: randomUUID(),
    });
    assert.equal(claude.status, 0, claude.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI accepts the current root Codex task and rejects another task identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-root-codex-owner-'));
  try {
    const state = join(directory, 'state');
    const rootTask = randomUUID();
    const environment = { CODEX_THREAD_ID: rootTask, CODEX_SESSION_ID: rootTask };
    const base = [
      '--state', state, 'add', 'https://github.com/example/project/pull/10',
      '--agent', 'codex', '--cwd', directory,
    ];

    const otherTask = run([...base, '--task', randomUUID()], environment);
    assert.equal(otherTask.status, 1);
    assert.match(otherTask.stderr, /--task must match the current Codex task/);

    const currentTask = run([...base, '--task', rootTask], environment);
    assert.equal(currentTask.status, 0, currentTask.stderr);
    assert.equal(object(currentTask.stdout).task, rootTask);
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

test('CLI reconciles an orphaned spawn window without changing a completed entry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-reconcile-delivery-'));
  try {
    const state = join(directory, 'state');
    const store = new Store(state);
    const added = store.add({
      url: 'https://github.com/example/project/pull/166',
      agent: 'codex', task: randomUUID(), cwd: directory,
    });
    const database = new DatabaseSync(store.databasePath);
    try {
      database.prepare('UPDATE entries SET token = ? WHERE id = ?').run('-reconcile_fixture_token', added.id);
    } finally { database.close(); }
    const reserved = store.reserve()[0];
    assert.ok(reserved?.token);
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.ok(dead.pid > 1);
    const ledger = new DeliveryLedger(state);
    assert.ok(ledger.admit(reserved, dead.pid));
    store.claim(added.id, reserved.token);
    const completed = store.done(added.id, reserved.token);
    ledger.close();
    store.close();

    const status = run(['--state', state, 'status']);
    assert.equal(status.status, 0, status.stderr);
    const attempts = object(status.stdout).delivery_attempts;
    assert.deepEqual(attempts, [{ entry_id: added.id, dispatcher_pid: dead.pid, child_pid: null }]);
    assert.deepEqual(Object.keys((attempts as Record<string, unknown>[])[0] ?? {}).sort(), [
      'child_pid', 'dispatcher_pid', 'entry_id',
    ]);

    const missingAssertion = run(['--state', state, 'reconcile-delivery', added.id, `--token=${reserved.token}`]);
    assert.equal(missingAssertion.status, 1);
    assert.match(missingAssertion.stderr, /requires --quiescent/);
    const reconciled = run([
      '--state', state, 'reconcile-delivery', added.id, `--token=${reserved.token}`, '--quiescent',
    ]);
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.equal(object(reconciled.stdout).state, 'done');
    assert.equal(object(reconciled.stdout).token, completed.token);

    const reopened = new DeliveryLedger(state);
    assert.ok(reopened.admit(completed, process.pid));
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('delivery reconciliation authenticates the current token after an older client rotated it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-reconcile-stale-attempt-'));
  try {
    const state = join(directory, 'state');
    const store = new Store(state);
    const added = store.add({
      url: 'https://github.com/example/project/pull/167',
      agent: 'codex', task: randomUUID(), cwd: directory,
    });
    const database = new DatabaseSync(store.databasePath);
    try {
      database.prepare('UPDATE entries SET token = ? WHERE id = ?').run('-stale_fixture_token', added.id);
    } finally { database.close(); }
    const reserved = store.reserve()[0];
    assert.ok(reserved?.token);
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.ok(dead.pid > 1);
    const ledger = new DeliveryLedger(state);
    assert.ok(ledger.admit(reserved, dead.pid));
    const replacement = store.retry(reserved.id, reserved.token);
    assert.ok(replacement.token);
    ledger.close();
    store.close();

    const stale = run([
      '--state', state, 'reconcile-delivery', reserved.id, `--token=${reserved.token}`, '--quiescent',
    ]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale or invalid ownership token/);
    const reconciled = run([
      '--state', state, 'reconcile-delivery', reserved.id, `--token=${replacement.token}`, '--quiescent',
    ]);
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.equal(object(reconciled.stdout).token, replacement.token);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI verifies the original owner after a successful single-use claim', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-verify-claim-'));
  try {
    const state = join(directory, 'state');
    const task = randomUUID();
    const cwd = realpathSync(directory);
    const store = new Store(state);
    const added = store.add({
      url: 'https://github.com/example/project/pull/164',
      agent: 'codex',
      task,
      cwd,
    });
    const reserved = store.reserve()[0];
    assert.ok(reserved);
    assert.ok(reserved.token);
    const claimed = store.claim(added.id, reserved.token);
    store.close();

    const repeated = run([
      '--state', state, 'claim', claimed.id, `--token=${reserved.token}`,
    ]);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /cannot be claimed from state claimed/);

    const verified = run([
      '--state', state, 'verify-claim', claimed.id, `--token=${reserved.token}`,
      '--agent', 'codex', '--task', task, '--cwd', directory,
    ]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(object(verified.stdout).state, 'claimed');

    const wrongOwner = run([
      '--state', state, 'verify-claim', claimed.id, `--token=${reserved.token}`,
      '--agent', 'claude', '--task', task, '--cwd', directory,
    ]);
    assert.equal(wrongOwner.status, 1);
    assert.match(wrongOwner.stderr, /different agent, task, cwd, or configuration root/);

    const wrongToken = run([
      '--state', state, 'verify-claim', claimed.id, '--token', 'stale-token',
      '--agent', 'codex', '--task', task, '--cwd', directory,
    ]);
    assert.equal(wrongToken.status, 1);
    assert.match(wrongToken.stderr, /stale or invalid ownership token/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('wake commands claim, verify and finish with a leading-dash ownership token', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-token-'));
  const previousEntrypoint = process.argv[1];
  assert.ok(previousEntrypoint);
  const state = join(directory, 'state');
  const store = new Store(state);
  try {
    const entry = store.add({
      url: 'https://github.com/example/project/pull/165',
      agent: 'codex', task: randomUUID(), cwd: directory,
    });
    // Base64url tokens can start with a dash; fix that producer-supported case in this fixture.
    const database = new DatabaseSync(store.databasePath);
    try {
      database.prepare('UPDATE entries SET token = ? WHERE id = ?').run('-fixture_token', entry.id);
    } finally { database.close(); }
    const reserved = store.reserve()[0];
    assert.ok(reserved);
    process.argv[1] = cli;
    const message = wakeMessage(reserved, state);
    const commands = [
      message.split('On the first wake run: ')[1]?.split('. Save its successful result.')[0],
      message.split('then run: ')[1]?.split('. A successful verification')[0],
      message.split('After completion and after all remote jobs have finished, run: ')[1]?.split('. If blocked')[0],
    ];
    for (const [index, command] of commands.entries()) {
      assert.ok(command);
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(object(result.stdout).state, index === 2 ? 'done' : 'claimed');
    }
    assert.equal(store.list()[0]?.state, 'done');
  } finally {
    process.argv[1] = previousEntrypoint;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
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


test('checkpoint follows registration, wake, claim and recovery without duplicating work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-checkpoint-'));
  try {
    const state = join(directory, 'state');
    const task = randomUUID();
    const filename = "review's continuation.md";
    const checkpoint = join(directory, filename);
    writeFileSync(checkpoint, 'Next: assess integration against the previous reviewed candidate.');
    const args = ['--state', state, 'add', 'https://github.com/example/project/pull/42',
      '--agent', 'codex', '--task', task, '--cwd', directory];
    const added = run([...args, '--checkpoint', filename]);
    assert.equal(added.status, 0, added.stderr);
    const entry = object(added.stdout);
    const path = realpathSync(checkpoint);
    assert.equal(entry.checkpoint_path, path);

    const duplicate = run(args);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.deepEqual(object(duplicate.stdout), entry);
    const sameFile = run([...args, '--checkpoint', path]);
    assert.equal(sameFile.status, 0, sameFile.stderr);
    assert.deepEqual(object(sameFile.stdout), entry);

    const store = new Store(state);
    const reserved = store.reserve()[0];
    assert.ok(reserved?.token);
    assert.equal(reserved.checkpoint_path, path);
    const pending = store.pendingNotifications()[0];
    assert.equal(pending?.checkpoint_path, path);
    assert.ok(wakeMessage(reserved, state).includes(JSON.stringify(path)));
    store.close();

    const claim = run(['--state', state, 'claim', reserved.id, `--token=${reserved.token}`]);
    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(object(claim.stdout).checkpoint_path, path);
    writeFileSync(checkpoint, 'Assessment 18: review middleware and expiry callers. CI run 891 remains active.');
    const verified = run(['--state', state, 'verify-claim', reserved.id, `--token=${reserved.token}`,
      '--agent', 'codex', '--task', task, '--cwd', directory]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(object(verified.stdout).checkpoint_path, path);
    assert.equal(readFileSync(path, 'utf8'), 'Assessment 18: review middleware and expiry callers. CI run 891 remains active.');

    const blocked = run(['--state', state, 'block', reserved.id, `--token=${reserved.token}`, '--reason', 'fixture interrupted']);
    assert.equal(blocked.status, 0, blocked.stderr);
    // No agent or remote jobs were launched in this fixture.
    const recovered = run(['--state', state, 'recover', reserved.id, `--token=${reserved.token}`, '--quiescent']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(object(recovered.stdout).checkpoint_path, path);
    assert.notEqual(object(recovered.stdout).token, reserved.token);
    const stale = run(['--state', state, 'claim', reserved.id, `--token=${reserved.token}`]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale or invalid ownership token/);

    // A missing artifact must not corrupt queue state or prevent ownership recovery.
    rmSync(checkpoint);
    const reopened = new Store(state);
    try {
      const wake = reopened.pendingNotifications()[0];
      assert.ok(wake?.token);
      assert.equal(wake.checkpoint_path, path);
      assert.ok(wakeMessage(wake, state).includes(JSON.stringify(path)));
      assert.equal(reopened.claim(wake.id, wake.token).checkpoint_path, path);
      assert.equal(reopened.done(wake.id, wake.token).state, 'done');
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid or replacement checkpoints cannot create or redirect a queue entry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-checkpoint-invalid-'));
  try {
    const state = join(directory, 'state');
    const args = ['--state', state, 'add', 'https://github.com/example/project/pull/43',
      '--agent', 'codex', '--task', randomUUID(), '--cwd', directory];
    for (const checkpoint of ['', directory, join(directory, 'missing')]) {
      const rejected = run([...args, '--checkpoint', checkpoint]);
      assert.equal(rejected.status, 1);
      const store = new Store(state);
      try { assert.deepEqual(store.list(), []); } finally { store.close(); }
    }
    const first = join(directory, 'first.md');
    const replacement = join(directory, 'replacement.md');
    writeFileSync(first, 'original workflow');
    writeFileSync(replacement, 'different workflow');
    const added = run([...args, '--checkpoint', first]);
    assert.equal(added.status, 0, added.stderr);
    const rejected = run([...args, '--checkpoint', replacement]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /different checkpoint/);
    const store = new Store(state);
    try { assert.deepEqual(store.list(), [object(added.stdout)]); } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

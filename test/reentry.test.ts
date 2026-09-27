import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/store.ts';
import type { AddEntryInput, Entry } from '../src/types.ts';

const task = '00000000-0000-4000-8000-000000000019';
const head = 'a'.repeat(40);
const plan = { base: 'main', head, members: [{ number: 1, head }] };

async function fixture(run: (store: Store, owner: AddEntryInput, root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'repoq-reentry-'));
  const store = new Store(join(root, 'state'));
  const checkpoint = join(root, 'checkpoint.json');
  writeFileSync(checkpoint, '{"next":"prepared native candidate"}\n');
  const owner: AddEntryInput = { url: 'https://github.com/fixture/reentry/pull/1', agent: 'codex', task, cwd: root,
    owner_config_root: join(homedir(), '.codex'), desktop: true, checkpoint_path: checkpoint };
  try { await run(store, owner, root); }
  finally { store.close(); rmSync(root, { force: true, recursive: true }); }
}
function complete(store: Store, owner: AddEntryInput): Entry & { token: string } {
  const entry = store.add(owner);
  assert.ok(entry.token);
  store.reserve();
  store.claim(entry.id, entry.token);
  return { ...store.done(entry.id, entry.token), token: entry.token };
}

function schema4(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF');
  const schema = readFileSync(resolve('test/fixtures/python-v0.sql'), 'utf8').split('INSERT INTO')[0];
  assert.ok(schema);
  database.exec(`${schema.replace('CREATE TABLE entries', 'CREATE TABLE entries_v4')}
    INSERT INTO entries_v4 SELECT * FROM entries;
    DROP TABLE entries;
    ALTER TABLE entries_v4 RENAME TO entries;
    DROP TABLE reentries;
    UPDATE sqlite_sequence SET seq = 90 WHERE name = 'entries';
    PRAGMA user_version = 4;
  `);
}

test('reentry preserves completed history and owner metadata, fences old tokens and refuses predecessor replay', async () => {
  await fixture((store, owner) => {
    const previous = complete(store, owner);
    const next = store.reenter(previous.id, previous.token, owner, plan, 'Native queue now required');
    assert.deepEqual(store.list()[0], previous);
    assert.notEqual(next.id, previous.id);
    assert.notEqual(next.token, previous.token);
    assert.equal(next.sequence, previous.sequence + 1);
    for (const key of ['agent', 'task', 'cwd', 'owner_config_root', 'owner_config_explicit', 'desktop', 'checkpoint_path'] as const) {
      assert.equal(next[key], previous[key]);
    }
    assert.equal(next.state, 'waiting');
    assert.equal(next.delivery_status, 'pending');
    assert.equal(next.native?.state, 'admission_pending');
    assert.equal(next.native?.request, null);
    assert.equal(store.reentries()[0]?.reason, 'Native queue now required');
    assert.equal(store.reentries()[0]?.previous_entry_id, previous.id);
    assert.equal(store.reentries()[0]?.entry_id, next.id);
    assert.deepEqual(store.add({ ...owner, native: plan }), next);
    assert.throws(() => store.add(owner), /retains its mode/);
    assert.throws(() => store.reenter(previous.id, previous.token, owner, plan, 'Replay'), /already has successor/);
    assert.throws(() => store.claim(next.id, previous.token), /stale or invalid/);
    assert.ok(next.native);
    store.updateNative(next.id, next.native, { ...next.native, state: 'merged' });
    assert.throws(() => store.reenter(previous.id, previous.token, owner, plan, 'Old replay'), /already has successor/);
    assert.equal(store.list().length, 2);
    assert.deepEqual(store.list()[0], previous);
  });
});

test('reentry rejects wrong owners, unfinished or native predecessors and invalid audit reasons without writing', async () => {
  await fixture((store, owner, root) => {
    const waiting = store.add(owner);
    assert.ok(waiting.token);
    assert.throws(() => store.reenter(waiting.id, waiting.token ?? '', owner, plan, 'Reason'), /completed legacy GitHub/);
    const previous = complete(store, owner);
    const otherCwd = join(root, 'another-worktree');
    mkdirSync(otherCwd);
    const before = store.list();
    for (const other of [{ ...owner, task: '00000000-0000-4000-8000-000000000020' }, { ...owner, owner_config_root: '/different/config' }, { ...owner, agent: 'claude' as const }, { ...owner, cwd: otherCwd }]) {
      assert.throws(() => store.reenter(previous.id, previous.token, other, plan, 'Reason'), /different agent, task, cwd, or configuration/);
    }
    assert.throws(() => store.reenter(previous.id, 'stale', owner, plan, 'Reason'), /stale or invalid/);
    for (const reason of ['', '  ', previous.token, 'x'.repeat(4097)]) {
      assert.throws(() => store.reenter(previous.id, previous.token, owner, plan, reason), /reason/);
    }
    assert.throws(() => store.reenter(previous.id, previous.token, owner, { ...plan, members: [{ number: 2, head }] }, 'Reason'), /does not match/);
    assert.deepEqual(store.list(), before);
    assert.deepEqual(store.reentries(), []);
    const native = store.reenter(previous.id, previous.token, owner, plan, 'Native required');
    assert.ok(native.native && native.token);
    store.updateNative(native.id, native.native, { ...native.native, state: 'merged' });
    assert.throws(() => store.reenter(native.id, native.token ?? '', owner, plan, 'Reason'), /completed legacy GitHub/);
    const bitbucket = complete(store, { ...owner, url: 'https://bitbucket.org/fixture/reentry/pull-requests/1' });
    assert.throws(() => store.reenter(bitbucket.id, bitbucket.token, owner, plan, 'Reason'), /completed legacy GitHub/);
  });
});

test('known historical configuration metadata is copied exactly, but an unknown root cannot be invented', async () => {
  await fixture((store, owner) => {
    const previous = complete(store, { ...owner, agent: 'claude', desktop: false });
    const database = new DatabaseSync(store.databasePath);
    database.prepare('UPDATE owner_configs SET env_explicit = NULL WHERE entry_id = ?').run(previous.id);
    const next = store.reenter(previous.id, previous.token, { ...owner, agent: 'claude' }, plan, 'Known historical root');
    assert.equal(next.owner_config_root, previous.owner_config_root);
    assert.equal(next.owner_config_explicit, undefined);
    assert.equal(next.desktop, false);
    const other = complete(store, { ...owner, url: 'https://github.com/fixture/unknown/pull/1' });
    database.prepare('DELETE FROM owner_configs WHERE entry_id = ?').run(other.id);
    assert.throws(() => store.reenter(other.id, other.token, owner, plan, 'Unknown root'), /known original configuration root/);
    assert.equal(store.list().length, 3);
    database.close();
  });
});

test('reentry excludes unfinished legacy and native prefix work without changing either owner', async () => {
  for (const native of [false, true]) {
    await fixture((store, owner) => {
      const previous = complete(store, owner);
      const other = store.add({ ...owner, url: 'https://github.com/fixture/reentry/pull/2',
        ...(native ? { native: { ...plan, members: [{ number: 2, head }] } } : {}) });
      const before = store.list();
      assert.throws(() => store.reenter(previous.id, previous.token, owner,
        { ...plan, members: [{ number: 2, head }, { number: 1, head }] }, 'Prepared prefix'), /overlaps an unfinished/);
      assert.deepEqual(store.list(), before);
      assert.deepEqual(store.reentries(), []);
      if (!native) assert.deepEqual(store.reserve().map(entry => entry.id), [other.id]);
    });
  }
});

test('concurrent reentry creates exactly one successor and audit', async () => {
  await fixture(async (store, owner) => {
    const previous = complete(store, owner);
    const workerSource = `
      import { parentPort, workerData } from 'node:worker_threads';
      const { Store } = await import(workerData.module);
      const store = new Store(workerData.state);
      try { store.reenter(workerData.id, workerData.token, workerData.owner, workerData.plan, 'Concurrent request'); parentPort.postMessage('created'); }
      catch (error) { parentPort.postMessage(error.message); }
      finally { store.close(); }
    `;
    const results = await Promise.all(Array.from({ length: 3 }, () => new Promise<unknown>((resolveWorker, reject) => {
      const worker = new Worker(workerSource, { eval: true, workerData: { module: pathToFileURL(resolve('src/store.ts')).href,
        state: store.stateDir, id: previous.id, token: previous.token, owner, plan } });
      worker.once('message', resolveWorker);
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    })));
    assert.equal(results.filter(result => result === 'created').length, 1);
    assert.equal(results.filter(result => typeof result === 'string' && result.includes('already has successor')).length, 2);
    assert.equal(store.list().length, 2);
    assert.equal(store.reentries().length, 1);
  });
});

test('schema 4 migration preserves all rows, children, audit, order and sequence high-water mark', async () => {
  await fixture((store, owner) => {
    const previous = complete(store, owner);
    for (const state of ['reserved', 'claimed', 'blocked', 'done'] as const) {
      const entry = store.add({ ...owner, agent: 'claude', desktop: false, url: `https://github.com/fixture/${state}/pull/1` });
      assert.ok(entry.token);
      store.reserve();
      if (state === 'claimed' || state === 'blocked') store.claim(entry.id, entry.token);
      if (state === 'blocked') store.block(entry.id, entry.token, 'Fixture hold');
      if (state === 'done') {
        store.beginDelivery(entry.id, entry.token);
        store.delivery(entry.id, entry.token, false, 'Fixture delivery rejected');
        store.completeMerged(entry.id, entry.token, 'Provider merged', entry.url, '2026-09-26T00:00:00Z');
      }
    }
    store.add({ ...owner, url: 'https://github.com/fixture/native/pull/1', native: plan });
    const database = new DatabaseSync(store.databasePath);
    schema4(database);
    database.prepare("UPDATE owner_configs SET env_explicit = 0 WHERE entry_id IN (SELECT id FROM entries WHERE agent = 'claude')").run();
    const tables = ['entries', 'owner_configs', 'entry_checkpoints', 'administrative_completions', 'native_queue'];
    const before = tables.map(table => database.prepare(`SELECT * FROM ${table}`).all());
    const original = store.list();
    const migrated = new Store(store.stateDir);
    try {
      assert.deepEqual(tables.map(table => database.prepare(`SELECT * FROM ${table}`).all()), before);
      assert.deepEqual(migrated.list(), original);
      assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 5);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      for (const table of tables.slice(1)) {
        assert.ok(database.prepare(`PRAGMA foreign_key_list(${table})`).all().every(row => row.table === 'entries'));
      }
      const next = migrated.reenter(previous.id, previous.token, owner, plan, 'Native queue now required');
      assert.equal(next.sequence, 91);
      assert.equal(migrated.verifyOwnership(previous.id, previous.token).state, 'done');
      assert.deepEqual(migrated.list().slice(0, original.length), original);
    } finally { migrated.close(); database.close(); }
  });
});


test('migration failure rolls back the parent rebuild, children and schema version', async () => {
  await fixture((store, owner) => {
    complete(store, owner);
    const database = new DatabaseSync(store.databasePath);
    try {
      schema4(database);
      database.prepare('INSERT INTO entry_checkpoints (entry_id, path) VALUES (?, ?)')
        .run('00000000-0000-4000-8000-000000000099', '/fixture/orphan.json');
      const schema = database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      const entries = database.prepare('SELECT * FROM entries').all();
      const checkpoints = database.prepare('SELECT * FROM entry_checkpoints').all();
      assert.throws(() => new Store(store.stateDir), /invalid foreign-key references/);
      assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 4);
      assert.deepEqual(database.prepare('SELECT * FROM entries').all(), entries);
      assert.deepEqual(database.prepare('SELECT * FROM entry_checkpoints').all(), checkpoints);
      assert.deepEqual(database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(), schema);
      assert.equal(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'entries'").get()?.seq, 90);
    } finally { database.close(); }
  });
});

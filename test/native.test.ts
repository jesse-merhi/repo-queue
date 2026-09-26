import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { monitorNative } from '../src/native-monitor.ts';
import { wakeMessage } from '../src/dispatcher.ts';
import { Store } from '../src/store.ts';
import type { Github, GithubObservation, NativeQueue } from '../src/native.ts';

const head = 'a'.repeat(40);
const owner = '00000000-0000-4000-8000-000000000001';
const observation: GithubObservation = { base: 'main', head, members: [{ number: 1, head }], required: true, state: 'OPEN', queue: null };

async function fixture(run: (store: Store, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'repoq-native-'));
  const store = new Store(root);
  try { await run(store, root); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
function add(store: Store, root: string, pr = 1, native = true) {
  return store.add({ url: `https://github.com/fixture/repo/pull/${pr}`, agent: 'codex', task: owner, cwd: root,
    ...(native ? { native: { base: 'main', head, members: [{ number: pr, head }] } } : {}) });
}
function current(store: Store, id: string) {
  const entry = store.list().find((entry) => entry.id === id);
  assert.ok(entry);
  assert.ok(entry.native);
  return { entry, native: entry.native };
}
function due(store: Store, id: string, changes: Partial<NativeQueue> = {}) {
  const { native } = current(store, id);
  assert.equal(store.updateNative(id, native, { ...native, ...changes, next_check: 0 }), true);
}
function provider(inspect: Github['inspect'], submit: Github['submit'] = async () => { throw new Error('Unexpected mutation'); }, result: Github['result'] = async () => { throw new Error('Unexpected result poll'); }): Github {
  return { inspect, submit, result };
}

test('native admission, validation and merge persist across reopen without acquiring local repository turn', async () => {
  await fixture(async (store, root) => {
    const native = add(store, root);
    const legacy = add(store, root, 2, false);
    assert.deepEqual(store.reserve().map((entry) => entry.id), [legacy.id]);
    let submissions = 0;
    await monitorNative(store, provider(async () => observation, async (_repo, pr, sha) => {
      assert.equal(pr, 1); assert.equal(sha, head); submissions++;
      return { status: 'pending', request: 'request-1', action: 'merge_queue', head };
    }));
    assert.equal(current(store, native.id).native.state, 'admission_pending');
    assert.equal(current(store, native.id).entry.state, 'waiting');
    assert.equal(current(store, native.id).native.request, 'request-1');
    const reopened = new Store(root);
    try {
      due(reopened, native.id);
      await monitorNative(reopened, provider(async () => ({ ...observation, queue: 'QUEUED' })));
      assert.equal(current(reopened, native.id).native.state, 'enqueued');
      due(reopened, native.id);
      await monitorNative(reopened, provider(async () => ({ ...observation, queue: 'AWAITING_CHECKS' })));
      assert.equal(current(reopened, native.id).native.state, 'validating');
      due(reopened, native.id);
      await monitorNative(reopened, provider(async () => ({ ...observation, state: 'MERGED' })));
      assert.equal(current(reopened, native.id).entry.state, 'done');
      assert.equal(current(reopened, native.id).native.state, 'merged');
      assert.equal(submissions, 1);
      assert.equal(reopened.list().find((entry) => entry.id === legacy.id)?.state, 'reserved');
    } finally { reopened.close(); }
  });
});

test('admission work and ejection wake the exact original owner once, without blocking unrelated local work', async () => {
  await fixture(async (store, root) => {
    const entry = add(store, root);
    await monitorNative(store, provider(async () => observation, async () => ({ status: 'pending', request: 'admission', action: 'merge_queue', head })));
    due(store, entry.id);
    await monitorNative(store, provider(async () => observation, undefined, async () => ({ status: 'failed', message: 'Required check is missing.' })));
    const repair = current(store, entry.id).entry;
    assert.equal(repair.state, 'reserved');
    assert.equal(repair.task, owner);
    assert.equal(repair.cwd, root);
    assert.equal(repair.owner_config_root, entry.owner_config_root);
    assert.equal(repair.native?.state, 'failed');
    assert.match(wakeMessage(repair, root), /repair turn, not a repository merge lock/);
    assert.match(wakeMessage(repair, root), new RegExp(owner));
    assert.ok(repair.token);
    store.claim(entry.id, repair.token);
    const resumed = store.resumeNative(entry.id, repair.token, observation);
    assert.notEqual(resumed.token, repair.token);
    assert.equal(resumed.native?.authorized_at, entry.native?.authorized_at);
    due(store, entry.id, { state: 'validating' });
    await monitorNative(store, provider(async () => observation));
    const failed = current(store, entry.id).entry;
    assert.equal(failed.native?.state, 'failed');
    assert.equal(failed.state, 'reserved');
    assert.ok(failed.token);
    store.beginDelivery(failed.id, failed.token);
    store.delivery(failed.id, failed.token, true);
    due(store, entry.id);
    await monitorNative(store, provider(async () => observation));
    assert.equal(current(store, entry.id).entry.delivery_status, 'sent');
    assert.equal(store.pendingNotifications().length, 0);
    const independent = add(store, root, 2, false);
    assert.deepEqual(store.reserve().map((entry) => entry.id), [independent.id]);
  });
});

test('saved submission intent survives a crash without a duplicate mutation', async () => {
  await fixture(async (store, root) => {
    const entry = add(store, root);
    due(store, entry.id, { state: 'submitting' });
    await monitorNative(store, provider(async () => observation));
    assert.equal(current(store, entry.id).native.state, 'uncertain');
    assert.equal(current(store, entry.id).entry.state, 'reserved');
  });
});

test('read outage preserves provider state and changed candidate never submits', async () => {
  await fixture(async (store, root) => {
    const entry = add(store, root);
    await monitorNative(store, provider(async () => { throw new Error('Network'); }));
    assert.equal(current(store, entry.id).native.state, 'admission_pending');
    assert.equal(current(store, entry.id).entry.state, 'waiting');
    due(store, entry.id);
    await monitorNative(store, provider(async () => ({ ...observation, head: 'b'.repeat(40) })));
    assert.equal(current(store, entry.id).native.state, 'failed');
    assert.equal(current(store, entry.id).entry.state, 'reserved');
  });
});

test('asynchronous acceptance with different merge action remains uncertain, never reports enqueued', async () => {
  await fixture(async (store, root) => {
    const entry = add(store, root);
    await monitorNative(store, provider(async () => observation, async () => ({ status: 'pending', request: 'existing', head, action: 'direct_merge' })));
    assert.equal(current(store, entry.id).native.state, 'uncertain');
    assert.equal(current(store, entry.id).entry.state, 'reserved');
  });
});

test('legacy owners cannot silently migrate and native repair cannot expand authorized scope or self-complete', async () => {
  await fixture(async (store, root) => {
    const legacy = add(store, root, 1, false);
    store.reserve();
    assert.ok(legacy.token);
    store.claim(legacy.id, legacy.token);
    assert.throws(() => add(store, root), /cannot silently migrate/);
    assert.equal(store.verifyOwnership(legacy.id, legacy.token).state, 'claimed');
    const entry = add(store, root, 2);
    const { native } = current(store, entry.id);
    store.updateNative(entry.id, native, { ...native, state: 'failed' }, true);
    assert.ok(entry.token);
    store.claim(entry.id, entry.token);
    assert.throws(() => store.done(entry.id, entry.token ?? ''), /provider-confirmed/);
    assert.throws(() => store.resumeNative(entry.id, entry.token ?? '', observation), /expand authorized/);
    assert.equal(current(store, entry.id).entry.state, 'claimed');
  });
});

test('late provider callback cannot overwrite the owner’s resumed candidate', async () => {
  await fixture(async (store, root) => {
    const entry = add(store, root);
    const { native } = current(store, entry.id);
    store.updateNative(entry.id, native, { ...native, state: 'failed' }, true);
    const stale = current(store, entry.id).native;
    assert.ok(entry.token);
    store.claim(entry.id, entry.token);
    const nextHead = 'b'.repeat(40);
    store.resumeNative(entry.id, entry.token, { base: 'main', head: nextHead, members: [{ number: 1, head: nextHead }] });
    assert.equal(store.updateNative(entry.id, stale, { ...stale, state: 'merged' }), false);
    assert.equal(current(store, entry.id).native.head, nextHead);
    assert.equal(current(store, entry.id).entry.state, 'waiting');
  });
});


test('schema 3 migration preserves legacy claimed and reserved ownership exactly', async () => {
  await fixture(async (store, root) => {
    const claimed = add(store, root, 1, false);
    store.reserve();
    assert.ok(claimed.token);
    store.claim(claimed.id, claimed.token);
    store.add({ url: 'https://github.com/fixture/other/pull/2', agent: 'claude', task: owner, cwd: root });
    store.reserve();
    const before = store.list();
    const database = new DatabaseSync(store.databasePath);
    database.exec('DROP TABLE native_queue; PRAGMA user_version = 3');
    database.close();
    const upgraded = new Store(root);
    try {
      assert.deepEqual(upgraded.list(), before);
      assert.equal(upgraded.reserve().length, 0);
      assert.equal(upgraded.verifyOwnership(claimed.id, claimed.token).state, 'claimed');
      const reader = new DatabaseSync(upgraded.databasePath);
      try { assert.equal(reader.prepare('PRAGMA user_version').get()?.user_version, 4); }
      finally { reader.close(); }
    } finally { upgraded.close(); }
  });
});


test('native stack registration cannot take over another unfinished registration in its prefix', async () => {
  await fixture(async (store, root) => {
    const lower = add(store, root, 1, false);
    store.reserve();
    assert.ok(lower.token);
    store.claim(lower.id, lower.token);
    assert.throws(() => store.add({
      url: 'https://github.com/fixture/repo/pull/2', agent: 'codex', task: owner, cwd: root,
      native: { base: 'main', head, members: [{ number: 1, head }, { number: 2, head }] },
    }), /overlaps an unfinished registration/);
    assert.equal(store.list().length, 1);
    assert.equal(store.verifyOwnership(lower.id, lower.token).state, 'claimed');
  });
});

test('expired or inaccessible asynchronous request wakes reconciliation without resubmission', async () => {
  await fixture(async (store, root) => {
    const entry = add(store, root);
    due(store, entry.id, { request: 'expired-request' });
    await monitorNative(store, provider(async () => observation, undefined, async () => ({ status: 'unavailable', message: 'Request no longer available.' })));
    assert.equal(current(store, entry.id).native.state, 'uncertain');
    assert.equal(current(store, entry.id).entry.state, 'reserved');
  });
});

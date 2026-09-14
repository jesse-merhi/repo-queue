import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeliveryLedger } from '../src/delivery-ledger.ts';
import type { Entry } from '../src/types.ts';

function entry(number: number, task = `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`): Entry {
  return {
    sequence: number,
    id: `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    url: `https://github.com/fixture/repository-${number}/pull/${number}`,
    provider: 'github', repo: `github.com/fixture/repository-${number}`, pr_number: number,
    agent: 'codex', task, cwd: tmpdir(), state: 'reserved', token: `token-${number}`,
    block_reason: '', delivery_status: 'pending', delivery_error: '',
    created_at: '2026-09-14T00:00:00.000000+00:00', updated_at: '2026-09-14T00:00:00.000000+00:00',
  };
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(child.pid > 1);
  return child.pid;
}

test('ledger retains four live-dispatcher attempts across reopen and serializes each owner', () => {
  const state = mkdtempSync(join(tmpdir(), 'repoq-ledger-'));
  try {
    const ledger = new DeliveryLedger(state);
    const first = ledger.admit(entry(1), 1);
    assert.ok(first);
    assert.equal(ledger.admit(entry(2, entry(1).task), process.pid), undefined);
    for (let number = 2; number <= 4; number += 1) assert.ok(ledger.admit(entry(number), process.pid));
    assert.equal(ledger.admit(entry(5), process.pid), undefined);
    ledger.close();

    const reopened = new DeliveryLedger(state);
    reopened.reconcile();
    assert.equal(reopened.admit(entry(5), process.pid), undefined);
    reopened.release(first);
    assert.ok(reopened.admit(entry(5), process.pid));
    reopened.close();
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('dead known children are reaped only after their dispatcher is dead', () => {
  const state = mkdtempSync(join(tmpdir(), 'repoq-ledger-reap-'));
  try {
    const ledger = new DeliveryLedger(state);
    const retained = ledger.admit(entry(10), process.pid);
    assert.ok(retained);
    ledger.spawned(retained, deadPid());
    ledger.reconcile();
    assert.equal(ledger.admit(entry(10), process.pid), undefined);
    ledger.release(retained);

    const orphan = ledger.admit(entry(11), deadPid());
    assert.ok(orphan);
    ledger.spawned(orphan, deadPid());
    ledger.reconcile();
    assert.ok(ledger.admit(entry(11), process.pid));
    ledger.close();
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('unknown spawn windows require an explicit quiescent reconciliation and refuse live parents', () => {
  const state = mkdtempSync(join(tmpdir(), 'repoq-ledger-unknown-'));
  try {
    const ledger = new DeliveryLedger(state);
    assert.ok(ledger.admit(entry(20), deadPid()));
    ledger.reconcile();
    assert.equal(ledger.admit(entry(20), process.pid), undefined);
    assert.throws(
      () => ledger.reconcileUnknown(entry(20).id, true, () => { throw new Error('stale token'); }),
      /stale token/,
    );
    assert.equal(ledger.admit(entry(20), process.pid), undefined);
    assert.throws(() => ledger.reconcileUnknown(entry(20).id, false, () => 'authorized'), /requires --quiescent/);
    assert.equal(ledger.reconcileUnknown(entry(20).id, true, () => 'authorized'), 'authorized');
    assert.ok(ledger.admit(entry(20), process.pid));

    const live = ledger.admit(entry(21), process.pid);
    assert.ok(live);
    assert.throws(() => ledger.reconcileUnknown(entry(21).id, true, () => 'authorized'), /live dispatcher/);
    ledger.close();
  } finally { rmSync(state, { recursive: true, force: true }); }
});

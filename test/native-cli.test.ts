import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { stop } from '../src/dispatcher.ts';
import { DeliveryLedger } from '../src/delivery-ledger.ts';
import { monitorNative } from '../src/native-monitor.ts';
import { Store } from '../src/store.ts';

const exec = promisify(execFile);
const cli = resolve('bin/repo-queue');
const task = '00000000-0000-4000-8000-000000000009';
const sha = 'a'.repeat(40);

async function fixture(run: (root: string, store: Store, command: (args: string[]) => Promise<string>, phase: (value: string) => void) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'repoq-native-cli-'));
  const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ''}`, REPOQ_NATIVE_FIXTURE: root, CODEX_THREAD_ID: task, CODEX_SESSION_ID: task };
  const oldPath = process.env.PATH;
  const oldFixture = process.env.REPOQ_NATIVE_FIXTURE;
  const store = new Store(join(root, 'state'));
  writeFileSync(join(root, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const root = process.env.REPOQ_NATIVE_FIXTURE;
const args = process.argv.slice(2);
fs.appendFileSync(root + '/calls', JSON.stringify(args) + '\\n');
const phase = fs.readFileSync(root + '/phase', 'utf8');
const head = '${sha}';
const stacked = ['stack','classic-stack','merged'].includes(phase);
const target = phase==='classic-stack'?'release/Stable':'main';
const pull = (number) => ({number, html_url:'https://github.com/fixture/repo/pull/'+number, merged_at:phase==='merged'?'2026-09-26T01:00:00Z':null, head:{sha:head}, base:{ref:stacked&&number===2?'feature/first':target}, stack:stacked?{number:7,base:{ref:target}}:null});
let result;
if (args.includes('graphql') && args.some(x=>x.includes('mergeQueue(branch:'))) {
 if (phase==='queue-error') { process.stderr.write('gh: Forbidden (HTTP 403)'); process.exit(1); }
 if (phase==='queue-malformed') result={data:{repository:{}}};
 else if (phase==='queue-graphql-error') result={errors:[{message:'Cannot read target queue'}],data:{repository:{mergeQueue:null}}};
 else result={data:{repository:{mergeQueue:phase==='legacy'||!args.includes('branch='+target)?null:{id:'fixture-queue'}}}};
}
else if (args.includes('graphql')) result={data:{repository:{pullRequest:{headRefOid:head,state:phase==='merged'?'MERGED':phase==='closed'?'CLOSED':'OPEN',mergeQueueEntry:phase==='queued'?{state:'QUEUED'}:phase==='validating'?{state:'AWAITING_CHECKS'}:null}}}};
else if(args.some(x=>x.includes('/rules/branches/'))) {
 if (phase==='queue-error') { process.stderr.write('gh: Forbidden (HTTP 403)'); process.exit(1); }
 result=['legacy','classic','classic-stack'].includes(phase)?[[]]:[[{type:'merge_queue'}]];
}
else if(args.some(x=>x.includes('/stacks/'))) result={base:{ref:target},pull_requests:[pull(1),pull(2)]};
else if(args.includes('PUT') && phase==='existing') {
 process.stdout.write(JSON.stringify({status:'pending',details:{uuid:'fixture-request',expected_head_sha:head,merge_action:'default',merge_method:'default',message:'Already pending'}}));
 process.stderr.write('gh: Conflict (HTTP 409)'); process.exit(1);
}
else if(args.includes('PUT')) result={status:'pending',details:{uuid:'fixture-request',expected_head_sha:head,merge_action:'merge_queue',merge_method:'default',message:'Accepted'}};
else if(args.some(x=>x.includes('/merge-async/')) && phase==='expired') {
 process.stdout.write(JSON.stringify({message:'Not Found'})); process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1);
}
else if(args.some(x=>x.includes('/merge-async/'))) result={status:'pending',details:{uuid:'fixture-request',expected_head_sha:head,merge_action:'merge_queue',merge_method:'default',message:'Pending'}};
else result=pull(args.some(x=>x.endsWith('/pulls/2'))?2:1);
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
  writeFileSync(join(root, 'codex'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.REPOQ_NATIVE_FIXTURE + '/wakes', JSON.stringify(process.argv.slice(2)) + '\\n');`, { mode: 0o700 });
  writeFileSync(join(root, 'prepared.json'), '{"prepared":true}\n');
  const phase = (value: string): void => { writeFileSync(join(root, 'phase'), value); };
  const command = async (args: string[]): Promise<string> => (await exec(process.execPath, [cli, '--state', store.stateDir, ...args], { env, timeout: 15_000 })).stdout;
  process.env.PATH = env.PATH;
  process.env.REPOQ_NATIVE_FIXTURE = root;
  phase('ready');
  try { await run(root, store, command, phase); }
  finally {
    await stop(store.stateDir);
    store.close();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldFixture === undefined) delete process.env.REPOQ_NATIVE_FIXTURE; else process.env.REPOQ_NATIVE_FIXTURE = oldFixture;
    rmSync(root, { recursive: true, force: true });
  }
}
function due(store: Store): void {
  for (const entry of store.list()) {
    assert.ok(entry.native);
    store.updateNative(entry.id, entry.native, { ...entry.native, next_check: 0 });
  }
}
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Dispatcher fixture timed out');
    await delay(30);
  }
}
const registration = (root: string, pr = 1): string[] => ['submit', `https://github.com/fixture/repo/pull/${pr}`, '--agent', 'codex', '--task', task, '--cwd', root, '--authorize-merge'];

test('CLI uses real stack-aware queue endpoint and never treats request acceptance as admission', async (t) => {
  await fixture(async (root, store, command, phase) => {
    phase('stack');
    await assert.rejects(command(registration(root, 2)), /whole prefix is authorized/);
    assert.equal(store.list().length, 0);
    await command([...registration(root, 2), '--stack']);
    t.diagnostic('CLI submit #2 --authorize-merge --stack: saved owner 00000000-0000-4000-8000-000000000009, prefix [1,2], admission_pending');
    assert.deepEqual(store.list()[0]?.native?.members.map((member) => member.number), [1, 2]);
    await monitorNative(store);
    assert.equal(store.list()[0]?.native?.state, 'admission_pending');
    assert.equal(store.list()[0]?.state, 'waiting');
    t.diagnostic('Runtime provider PUT /pulls/2/merge-async accepted: admission_pending, not enqueued');
    const calls: unknown[] = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const mutation = calls.find((value) => Array.isArray(value) && value.includes('PUT'));
    assert.ok(Array.isArray(mutation));
    assert.ok(mutation.includes('/repos/fixture/repo/pulls/2/merge-async'));
    assert.ok(mutation.includes('merge_action=merge_queue'));
    assert.ok(mutation.includes(`sha=${sha}`));
    phase('queued'); due(store); await monitorNative(store);
    assert.equal(store.list()[0]?.native?.state, 'enqueued');
    await command(['status']);
    t.diagnostic('CLI status after provider QUEUED: native=enqueued, local=waiting');
    phase('validating'); due(store); await monitorNative(store);
    assert.equal(store.list()[0]?.native?.state, 'validating');
    await command(['status']);
    t.diagnostic('CLI status after provider AWAITING_CHECKS: native=validating, local=waiting');
    phase('merged'); due(store); await monitorNative(store);
    assert.equal(store.list()[0]?.native?.state, 'merged');
    assert.equal(store.list()[0]?.state, 'done');
    await command(['status']);
    t.diagnostic('CLI status after provider MERGED: native=merged, local=done');
  });
});

test('detached dispatcher delivers a single ejection wake to the saved session, and CLI resumes its repair', async (t) => {
  await fixture(async (root, store, command, phase) => {
    await command(registration(root));
    const entry = store.list()[0];
    assert.ok(entry?.native);
    store.updateNative(entry.id, entry.native, { ...entry.native, state: 'validating' });
    phase('ejected');
    await command(['start']);
    await until(() => store.list()[0]?.delivery_status === 'sent');
    await command(['stop']);
    const failed = store.list()[0];
    assert.ok(failed?.token);
    assert.equal(failed.native?.state, 'failed');
    const wakes = readFileSync(join(root, 'wakes'), 'utf8').trim().split('\n');
    assert.equal(wakes.length, 1);
    t.diagnostic('Dispatcher observed ejection: native=failed; exactly one codex queue --thread 00000000-0000-4000-8000-000000000009 repair wake');
    const wake: unknown = JSON.parse(wakes[0] ?? 'null');
    assert.ok(Array.isArray(wake));
    assert.deepEqual(wake.slice(0, 3), ['queue', '--thread', task]);
    assert.match(String(wake[4]), /removed or ejected/);
    await command(['claim', failed.id, `--token=${failed.token}`]);
    assert.equal(store.list()[0]?.state, 'claimed');
    t.diagnostic('CLI claim with original repair token: local=claimed (not merged)');
    phase('ready');
    await command(['resume-native', failed.id, `--token=${failed.token}`]);
    assert.equal(store.list()[0]?.state, 'waiting');
    assert.equal(store.list()[0]?.native?.authorized_at, entry.native.authorized_at);
    assert.notEqual(store.list()[0]?.token, failed.token);
    t.diagnostic('CLI resume-native: local=waiting; authorization preserved; old token fenced');
  });
});


test('native submission requires explicit authority, fails closed on queue errors, and preserves legacy fallback', async () => {
  await fixture(async (root, store, command, phase) => {
    await assert.rejects(command(registration(root).filter((arg) => arg !== '--authorize-merge')), /requires --authorize-merge/);
    phase('queue-error');
    await assert.rejects(command(registration(root)), /GitHub API request failed/);
    assert.equal(store.list().length, 0);
    phase('legacy');
    await command(registration(root));
    assert.equal(store.list()[0]?.native, undefined);
    assert.equal(store.reserve().length, 1);
  });
});

test('conflicting accepted request retains its UUID and quiescence never bypasses provider-confirmed pending work', async () => {
  await fixture(async (root, store, command, phase) => {
    phase('existing');
    await command(registration(root));
    await monitorNative(store);
    const entry = store.list()[0];
    assert.ok(entry?.token);
    assert.equal(entry.native?.state, 'uncertain');
    assert.equal(entry.native?.request, 'fixture-request');
    await command(['claim', entry.id, `--token=${entry.token}`]);
    await assert.rejects(command(['resume-native', entry.id, `--token=${entry.token}`, '--quiescent']), /not confirmed failed/);
    assert.equal(store.list()[0]?.state, 'claimed');
    phase('expired');
    await assert.rejects(command(['resume-native', entry.id, `--token=${entry.token}`]), /requires --quiescent/);
    await command(['resume-native', entry.id, `--token=${entry.token}`, '--quiescent']);
    assert.equal(store.list()[0]?.state, 'waiting');
    assert.equal(store.list()[0]?.native?.request, null);
  });
});


test('legacy registration cannot take over a claimed native prefix and unrelated legacy work remains eligible', async (t) => {
  await fixture(async (root, store, command, phase) => {
    phase('stack');
    await command([...registration(root, 2), '--stack']);
    const native = store.list()[0];
    assert.ok(native?.native);
    assert.ok(native.token);
    store.updateNative(native.id, native.native, { ...native.native, state: 'failed' }, true);
    store.claim(native.id, native.token);
    const original = store.list()[0];
    const legacy = ['--agent', 'claude', '--task', '00000000-0000-4000-8000-000000000010', '--cwd', root];
    await assert.rejects(command(['add', 'https://github.com/fixture/repo/pull/1', ...legacy]), /overlaps an unfinished registration/);
    assert.deepEqual(store.list(), [original]);
    await command(['add', 'https://github.com/fixture/repo/pull/3', ...legacy]);
    assert.deepEqual(store.reserve().map((entry) => entry.pr_number), [3]);
    assert.deepEqual(store.list()[0], original);
    t.diagnostic('CLI add for native-owned lower PR rejected; native owner unchanged; unrelated legacy #3 reserved');
  });
});

test('classic protection selects native mode for the actual target, including a stack base', async (t) => {
  for (const scenario of [{ phase: 'classic', pr: 1, base: 'main' }, { phase: 'classic-stack', pr: 2, base: 'release/Stable' }]) {
    await fixture(async (root, store, command, phase) => {
      phase(scenario.phase);
      await command([...registration(root, scenario.pr), ...(scenario.pr === 2 ? ['--stack'] : [])]);
      const entry = store.list()[0];
      assert.ok(entry?.native);
      assert.equal(entry.native.base, scenario.base);
      assert.equal(entry.native.state, 'admission_pending');
      assert.deepEqual(store.reserve(), []);
      t.diagnostic(`CLI submit #${scenario.pr}: native queue detected on ${scenario.base} with no ruleset queue`);
    });
  }
});

test('missing or errored native queue capability cannot silently become a legacy turn', async () => {
  await fixture(async (root, store, command, phase) => {
    for (const value of ['queue-malformed', 'queue-graphql-error']) {
      phase(value);
      await assert.rejects(command(registration(root)), /GitHub/);
      assert.deepEqual(store.list(), []);
    }
  });
});

const reentry = (root: string, id: string, token: string): string[] => ['reenter', id, `--token=${token}`,
  '--agent', 'codex', '--task', task, '--cwd', root, '--quiescent', '--authorize-merge', '--reason', 'Prepared after native queue enablement'];

async function completeLegacy(root: string, store: Store, command: (args: string[]) => Promise<string>, pr = 1, checkpoint = true) {
  await command(['add', `https://github.com/fixture/repo/pull/${pr}`, '--agent', 'codex', '--task', task, '--cwd', root,
    ...(checkpoint ? ['--checkpoint', join(root, 'prepared.json')] : [])]);
  const entry = store.reserve()[0];
  assert.ok(entry?.token);
  await command(['claim', entry.id, `--token=${entry.token}`]);
  await command(['done', entry.id, `--token=${entry.token}`]);
  return { ...store.verifyOwnership(entry.id, entry.token), token: entry.token };
}

test('completed legacy owner reenters a native queue with a fresh repair wake and unchanged history', async (t) => {
  await fixture(async (root, store, command, phase) => {
    const previous = await completeLegacy(root, store, command);
    await assert.rejects(command(registration(root)), /retains its mode/);
    t.diagnostic('Before: submit for completed legacy #1 rejects native mode; recover cannot reopen its claim.');
    await command(reentry(root, previous.id, previous.token));
    const next = store.list()[1];
    assert.ok(next?.native && next.token);
    assert.notEqual(next.id, previous.id);
    assert.notEqual(next.token, previous.token);
    assert.deepEqual(store.list()[0], previous);
    await command(registration(root));
    assert.equal(store.list().length, 2);
    await assert.rejects(command(reentry(root, previous.id, previous.token)), /already has successor/);
    assert.equal(store.reentries()[0]?.entry_id, next.id);
    t.diagnostic('After: reenter creates a fresh waiting/native attempt, retains old done row and audits the reason; submit is idempotent on the successor.');
    await monitorNative(store);
    const calls: unknown[] = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const mutations = calls.filter(value => Array.isArray(value) && value.includes('PUT'));
    assert.equal(mutations.length, 1);
    const mutation = mutations[0];
    assert.ok(Array.isArray(mutation));
    assert.ok(mutation.includes('merge_action=merge_queue'));
    assert.ok(mutation.includes(`sha=${sha}`));
    phase('queued');
    const saved = store.list()[1]?.native;
    assert.ok(saved);
    store.updateNative(next.id, saved, { ...saved, next_check: 0 });
    await monitorNative(store);
    phase('ejected');
    const queued = store.list()[1]?.native;
    assert.ok(queued);
    store.updateNative(next.id, queued, { ...queued, next_check: 0 });
    await command(['start']);
    await until(() => store.list()[1]?.delivery_status === 'sent');
    await command(['stop']);
    const wakes = readFileSync(join(root, 'wakes'), 'utf8').trim().split('\n');
    assert.equal(wakes.length, 1);
    const wake: unknown = JSON.parse(wakes[0] ?? 'null');
    assert.ok(Array.isArray(wake));
    assert.deepEqual(wake.slice(0, 3), ['queue', '--thread', task]);
    assert.match(String(wake[4]), new RegExp(next.id));
    assert.ok(String(wake[4]).includes(`--token=${next.token}`));
    assert.ok(!String(wake[4]).includes(previous.token));
    await assert.rejects(command(['claim', next.id, `--token=${previous.token}`]), /stale or invalid/);
    await command(['claim', next.id, `--token=${next.token}`]);
    phase('ready');
    await command(['resume-native', next.id, `--token=${next.token}`]);
    assert.equal(store.list()[1]?.state, 'waiting');
    assert.deepEqual(store.list()[0], previous);
    const status: unknown = JSON.parse(await command(['status']));
    assert.ok(typeof status === 'object' && status !== null && 'reentries' in status);
    assert.deepEqual(status.reentries, store.reentries());
    t.diagnostic('Simulated provider received one queue-only request at the prepared SHA; ejection delivered one wake to the saved task with only the new token; the owner claimed and resumed it.');
  });
});

test('reentry fails closed on provider state, missing authority, prior delivery and unfinished prefix ownership', async () => {
  await fixture(async (root, store, command, phase) => {
    const previous = await completeLegacy(root, store, command, 2);
    const args = reentry(root, previous.id, previous.token);
    await assert.rejects(command(args.filter(arg => arg !== '--quiescent')), /requires --quiescent/);
    await assert.rejects(command(args.filter(arg => arg !== '--authorize-merge')), /requires --authorize-merge/);
    for (const [value, error] of [
      ['closed', /requires an open PR/], ['merged', /requires an open PR/],
      ['legacy', /requires a native GitHub queue/], ['queue-error', /GitHub API request failed/],
      ['queued', /already in the GitHub queue/], ['stack', /whole prefix is authorized/],
    ] as const) {
      phase(value);
      await assert.rejects(command(args), error);
      assert.deepEqual(store.list(), [previous]);
      assert.deepEqual(store.reentries(), []);
    }
    phase('stack');
    await command(['add', 'https://github.com/fixture/repo/pull/1', '--agent', 'codex', '--task', task, '--cwd', root]);
    await assert.rejects(command([...args, '--stack']), /overlaps an unfinished/);
    assert.deepEqual(store.list()[0], previous);
    assert.deepEqual(store.reentries(), []);
    const calls: unknown[] = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(value => Array.isArray(value) && !value.includes('PUT')));
    assert.equal(existsSync(join(root, 'wakes')), false);
  });
  await fixture(async (root, store, command) => {
    await command(['add', 'https://github.com/fixture/repo/pull/1', '--agent', 'codex', '--task', task, '--cwd', root, '--checkpoint', join(root, 'prepared.json')]);
    const entry = store.reserve()[0];
    assert.ok(entry?.token);
    const ledger = new DeliveryLedger(store.stateDir);
    try {
      const attempt = ledger.admit(entry, process.pid);
      assert.ok(attempt);
      await command(['claim', entry.id, `--token=${entry.token}`]);
      await command(['done', entry.id, `--token=${entry.token}`]);
      const previous = store.list()[0];
      await assert.rejects(command(reentry(root, entry.id, entry.token)), /delivery is active or unreconciled/);
      assert.deepEqual(store.list(), [previous]);
      assert.deepEqual(store.reentries(), []);
      ledger.release(attempt);
      await command(reentry(root, entry.id, entry.token));
      assert.equal(store.list().length, 2);
    } finally { ledger.close(); }
  });
});


test('reentry attaches a prepared checkpoint only to a successor when history has none', async () => {
  await fixture(async (root, store, command) => {
    const previous = await completeLegacy(root, store, command, 1, false);
    assert.equal(previous.checkpoint_path, undefined);
    const args = reentry(root, previous.id, previous.token);
    await assert.rejects(command(args), /requires a prepared checkpoint/);
    await assert.rejects(command([...args, '--checkpoint', join(root, 'missing.json')]), /ENOENT/);
    await assert.rejects(command([...args, '--checkpoint', root]), /regular file/);
    assert.deepEqual(store.list(), [previous]);
    assert.deepEqual(store.reentries(), []);
    const calls: unknown[] = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(value => Array.isArray(value) && !value.includes('PUT')));
    assert.equal(existsSync(join(root, 'wakes')), false);
    const checkpoint = join(root, 'prepared.json');
    await command([...args, '--checkpoint', checkpoint]);
    assert.equal(store.list()[1]?.checkpoint_path, realpathSync(checkpoint));
    assert.deepEqual(store.list()[0], previous);
  });
});

test('reentry preserves an existing checkpoint and requires its original file to be restored', async () => {
  await fixture(async (root, store, command) => {
    const previous = await completeLegacy(root, store, command);
    const args = reentry(root, previous.id, previous.token);
    const checkpoint = join(root, 'prepared.json');
    const replacement = join(root, 'replacement.json');
    writeFileSync(replacement, '{"prepared":true}\n');
    await assert.rejects(command([...args, '--checkpoint', replacement]), /preserve the saved checkpoint/);
    rmSync(checkpoint);
    await assert.rejects(command(args), /ENOENT/);
    await assert.rejects(command([...args, '--checkpoint', replacement]), /preserve the saved checkpoint/);
    assert.deepEqual(store.list(), [previous]);
    assert.deepEqual(store.reentries(), []);
    const calls: unknown[] = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(value => Array.isArray(value) && !value.includes('PUT')));
    assert.equal(existsSync(join(root, 'wakes')), false);
    writeFileSync(checkpoint, '{"prepared":true}\n');
    await command([...args, '--checkpoint', checkpoint]);
    assert.equal(store.list()[1]?.checkpoint_path, previous.checkpoint_path);
    assert.deepEqual(store.list()[0], previous);
  });
});

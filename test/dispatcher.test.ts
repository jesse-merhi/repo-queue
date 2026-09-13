import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { running, start, stop, wakeMessage } from '../src/dispatcher.ts';
import { Store } from '../src/store.ts';
import type { Agent, Entry } from '../src/types.ts';

const cli = resolve('bin/repo-queue');
const exec = promisify(execFile);

function executable(directory: string, name: string, source: string): void {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

async function until(condition: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function command(state: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<unknown> {
  const result = await exec(process.execPath, [cli, '--state', state, ...args], {
    env: environment,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

function add(state: string, root: string, number: number, task: string, agent: Agent = 'codex'): Entry {
  const store = new Store(state);
  try {
    return store.add({
      url: `https://github.com/fixture/repository-${number}/pull/${number}`,
      agent,
      task,
      cwd: root,
    });
  } finally {
    store.close();
  }
}

async function fixture(run: (root: string, state: string, environment: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'repoq-dispatcher-'));
  const state = join(root, 'state');
  const environment = {
    ...process.env,
    PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
    REPOQ_FIXTURE: root,
  };
  try {
    await run(root, state, environment);
  } finally {
    try {
      await stop(state);
      await until(async () => !(await running(state)), 'dispatcher shutdown');
    } catch {
      // A test can intentionally crash the dispatcher before the lease exists.
    }
    const pids = join(root, 'pids');
    if (existsSync(pids)) {
      for (const text of readFileSync(pids, 'utf8').trim().split('\n')) {
        const pid = Number(text);
        if (Number.isSafeInteger(pid) && pid > 1) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('concurrent starts keep one dispatcher and repositories advance independently', async () => {
  await fixture(async (root, state, environment) => {
    const messages = join(root, 'messages');
    writeFileSync(messages, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/messages', JSON.stringify(process.argv.slice(2)) + '\\n');
    `);
    const firstTask = '10000000-0000-4000-8000-000000000001';
    const first = add(state, root, 1, firstTask);
    const store = new Store(state);
    const second = store.add({
      url: 'https://github.com/fixture/repository-1/pull/2',
      agent: 'codex',
      task: '10000000-0000-4000-8000-000000000002',
      cwd: root,
    });
    store.close();
    const other = add(state, root, 3, '10000000-0000-4000-8000-000000000003');

    await Promise.all([
      command(state, ['start'], environment),
      command(state, ['start'], environment),
    ]);
    await until(() => readFileSync(messages, 'utf8').trim().split('\n').filter(Boolean).length === 2, 'first repository turns');
    let text = readFileSync(messages, 'utf8');
    assert.match(text, new RegExp(first.id));
    assert.match(text, new RegExp(other.id));
    assert.doesNotMatch(text, new RegExp(second.id));

    const transition = new Store(state);
    transition.claim(first.id, first.token ?? '');
    transition.done(first.id, first.token ?? '');
    transition.close();
    await until(() => readFileSync(messages, 'utf8').trim().split('\n').filter(Boolean).length === 3, 'next turn');
    text = readFileSync(messages, 'utf8');
    assert.match(text, new RegExp(second.id));
    assert.equal(await running(state), true);

    await command(state, ['stop'], environment);
    await until(async () => !(await running(state)), 'explicit stop');
    const stopped = new Store(state);
    assert.equal(stopped.list().find((entry) => entry.id === other.id)?.state, 'reserved');
    stopped.close();
    await command(state, ['start'], environment);
    await until(() => running(state), 'restart after stop');
    await command(state, ['stop'], environment);
    await until(async () => !(await running(state)), 'second shutdown');
  });
});

test('delivery failures retain the reservation, redact the token, and require explicit retry', async () => {
  await fixture(async (root, state, environment) => {
    const fail = join(root, 'fail');
    const messages = join(root, 'messages');
    writeFileSync(fail, '');
    writeFileSync(messages, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      const message = process.argv.at(-1);
      if (fs.existsSync(process.env.REPOQ_FIXTURE + '/fail')) {
        process.stderr.write('failed token from message: ' + message);
        process.exit(7);
      }
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/messages', message + '\\n');
    `);
    const first = add(state, root, 10, '10000000-0000-4000-8000-000000000010');
    const queue = new Store(state);
    const second = queue.add({
      url: 'https://github.com/fixture/repository-10/pull/11',
      agent: 'codex',
      task: '10000000-0000-4000-8000-000000000011',
      cwd: root,
    });
    queue.close();
    await command(state, ['start'], environment);

    await until(() => {
      const probe = new Store(state);
      try { return probe.list()[0]?.delivery_status === 'failed'; } finally { probe.close(); }
    }, 'failed delivery');
    const probe = new Store(state);
    const failed = probe.list();
    probe.close();
    assert.equal(failed[0]?.state, 'reserved');
    assert.equal(failed[1]?.state, 'waiting');
    assert.doesNotMatch(failed[0]?.delivery_error ?? '', new RegExp(first.token ?? 'never'));

    unlinkSync(fail);
    const retry = new Store(state);
    const replacement = retry.retry(first.id, first.token ?? '');
    retry.close();
    assert.notEqual(replacement.token, first.token);
    await until(() => readFileSync(messages, 'utf8').includes(replacement.token ?? 'missing-token'), 'retried wake');
    const final = new Store(state);
    assert.equal(final.list().find((entry) => entry.id === second.id)?.state, 'waiting');
    final.close();
  });
});

test('a crash leaves an in-flight send uncertain on the next exclusive startup', async () => {
  await fixture(async (root, state, environment) => {
    writeFileSync(join(root, 'started'), '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/pids', process.pid + '\\n');
      fs.writeFileSync(process.env.REPOQ_FIXTURE + '/started', 'yes');
      setInterval(() => {}, 1000);
    `);
    const queued = add(state, root, 20, '10000000-0000-4000-8000-000000000020');
    const daemon = spawn(process.execPath, [cli, '--state', state, 'serve'], {
      env: environment,
      stdio: 'ignore',
    });
    await until(() => readFileSync(join(root, 'started'), 'utf8') === 'yes', 'in-flight adapter');
    daemon.kill('SIGKILL');
    await new Promise<void>((resolveExit) => daemon.once('exit', () => resolveExit()));
    await until(async () => !(await running(state)), 'crashed lease release');

    await command(state, ['start'], environment);
    await until(() => {
      const store = new Store(state);
      try { return store.list().find((entry) => entry.id === queued.id)?.delivery_status === 'uncertain'; }
      finally { store.close(); }
    }, 'uncertain reconciliation');
  });
});

test('stop releases the dispatcher without terminating an active agent process', async () => {
  await fixture(async (root, state, environment) => {
    writeFileSync(join(root, 'started'), '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/pids', process.pid + '\\n');
      fs.writeFileSync(process.env.REPOQ_FIXTURE + '/started', String(process.pid));
      setInterval(() => {}, 1000);
    `);
    add(state, root, 25, '10000000-0000-4000-8000-000000000025');
    const daemon = spawn(process.execPath, [cli, '--state', state, 'serve'], {
      env: environment,
      stdio: 'ignore',
    });
    await until(() => readFileSync(join(root, 'started'), 'utf8').length > 0, 'active adapter process');
    await command(state, ['stop'], environment);
    const daemonExit = daemon.exitCode === null
      ? new Promise<void>((resolveExit) => daemon.once('exit', () => resolveExit()))
      : Promise.resolve();
    await Promise.race([
      daemonExit,
      delay(3_000, undefined, { ref: false }).then(() => {
        throw new Error('dispatcher waited for the active agent during stop');
      }),
    ]);

    const agentPid = Number(readFileSync(join(root, 'started'), 'utf8'));
    assert.doesNotThrow(() => process.kill(agentPid, 0));
    const store = new Store(state);
    assert.equal(store.list()[0]?.delivery_status, 'sending');
    store.close();
  });
});

test('delivery is globally bounded and serialized per owning session', async () => {
  await fixture(async (root, state, environment) => {
    const starts = join(root, 'starts');
    const gate = join(root, 'gate');
    writeFileSync(starts, '');
    writeFileSync(gate, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const task = args[args.indexOf('--thread') + 1];
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/starts', task + '\\n');
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.REPOQ_FIXTURE + '/gate')) { clearInterval(timer); process.exit(0); }
      }, 20);
    `);
    const sharedTask = '10000000-0000-4000-8000-000000000030';
    add(state, root, 30, sharedTask);
    add(state, root, 31, sharedTask);
    for (let number = 32; number <= 35; number += 1) {
      add(state, root, number, `10000000-0000-4000-8000-0000000000${number}`);
    }
    await command(state, ['start'], environment);
    await until(() => readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).length === 4, 'four concurrent deliveries');

    const active = new Store(state);
    const statuses = active.list().map((entry) => entry.delivery_status);
    active.close();
    assert.equal(statuses.filter((status) => status === 'sending').length, 4);
    assert.equal(statuses.filter((status) => status === 'pending').length, 2);
    assert.equal(readFileSync(starts, 'utf8').trim().split('\n').filter((owner) => owner === sharedTask).length, 1);

    unlinkSync(gate);
    await until(() => readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).length === 6, 'remaining serialized deliveries');
  });
});

test('legacy Python lock markers block Node start and serve migration', async () => {
  await fixture(async (_root, state) => {
    const initialized = new Store(state);
    initialized.close();
    const marker = join(state, 'dispatcher.lock');
    writeFileSync(marker, '');
    await assert.rejects(start(state), /Stop the Python dispatcher/);
    const processArgv = process.argv[1];
    assert(processArgv);
    const example = add(state, tmpdir(), 40, '10000000-0000-4000-8000-000000000040');
    assert.match(wakeMessage(example, state), new RegExp(resolve(processArgv).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

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
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { codexClaimGraceMs } from '../src/claim-watch.ts';
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

function add(
  state: string,
  root: string,
  number: number,
  task: string,
  agent: Agent = 'codex',
  ownerConfigRoot?: string,
  desktop = false,
): Entry {
  const store = new Store(state);
  try {
    return store.add({
      url: `https://github.com/fixture/repository-${number}/pull/${number}`,
      agent,
      task,
      cwd: root,
      ...(ownerConfigRoot === undefined ? {} : { owner_config_root: ownerConfigRoot }),
      ...(desktop ? { desktop: true } : {}),
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
  executable(root, 'open', '');
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
      ...Array.from({ length: 8 }, () => command(state, ['status'], environment)),
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

test('an immediate CLI restart replaces the stopped dispatcher and delivers later work', async () => {
  await fixture(async (root, state, environment) => {
    const messages = join(root, 'messages');
    writeFileSync(messages, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/messages', process.argv.at(-1) + '\\n');
    `);

    await command(state, ['start'], environment);
    await command(state, ['stop'], environment);
    await command(state, ['start'], environment);
    const queued = add(state, root, 4, '10000000-0000-4000-8000-000000000004');

    await until(() => readFileSync(messages, 'utf8').includes(queued.id), 'delivery after immediate restart');
    assert.equal(await running(state), true);
  });
});

test('dispatcher reports one overdue Codex claim without resending or changing ownership', async () => {
  await fixture(async (root, state, environment) => {
    const messages = join(root, 'messages');
    writeFileSync(messages, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/messages', JSON.stringify(process.argv.slice(2)) + '\\n');
    `);
    const queued = add(state, root, 942, '10000000-0000-4000-8000-000000000942');
    await command(state, ['start'], environment);
    await until(() => {
      const store = new Store(state);
      try { return store.list()[0]?.delivery_status === 'sent'; }
      finally { store.close(); }
    }, 'native acceptance');
    const database = new DatabaseSync(join(state, 'queue.sqlite3'));
    try {
      database.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(
        new Date(Date.now() - codexClaimGraceMs - 1_000).toISOString(), queued.id,
      );
    } finally { database.close(); }

    const log = join(state, 'dispatcher.log');
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('codex_claim_overdue'), 'overdue claim warning');
    await delay(1_200);
    const warnings = readFileSync(log, 'utf8').match(/codex_claim_overdue/g) ?? [];
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(readFileSync(log, 'utf8'), new RegExp(queued.token ?? ''));
    assert.equal(readFileSync(messages, 'utf8').trim().split('\n').length, 1);
    const store = new Store(state);
    try {
      const current = store.list()[0];
      assert.equal(current?.state, 'reserved');
      assert.equal(current?.token, queued.token);
      assert.equal(current?.delivery_status, 'sent');
      assert.equal(store.claim(queued.id, queued.token ?? '').state, 'claimed');
    } finally { store.close(); }
  });
});

test('failed desktop activation retains accepted delivery and alerts without retrying the wake', {
  skip: process.platform !== 'darwin',
}, async () => {
  await fixture(async (root, state, environment) => {
    const messages = join(root, 'messages');
    const activation = join(root, 'activation.json');
    executable(root, 'codex', `
      require('node:fs').appendFileSync(process.env.REPOQ_FIXTURE + '/messages', 'queued\\n');
    `);
    executable(root, 'open', `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(process.env.REPOQ_FIXTURE + '/state/queue.sqlite3');
      const row = database.prepare('SELECT delivery_status FROM entries').get();
      fs.writeFileSync(process.env.REPOQ_FIXTURE + '/activation.json', JSON.stringify({
        args: process.argv.slice(2), status: row.delivery_status,
      }));
      database.close();
      process.stderr.write('desktop unavailable');
      process.exit(1);
    `);
    const queued = add(state, root, 943, '10000000-0000-4000-8000-000000000943',
      'codex', join(homedir(), '.codex'), true);
    await command(state, ['start'], environment);
    await until(() => existsSync(activation), 'desktop activation request');
    await until(async () => {
      const status = await command(state, ['status'], environment);
      return JSON.stringify(status).includes('codex_activation_request_failed');
    }, 'activation failure alert');
    assert.deepEqual(JSON.parse(readFileSync(activation, 'utf8')), {
      args: ['-g', `codex://threads/${queued.task}`], status: 'sent',
    });
    const store = new Store(state);
    try {
      const current = store.list()[0];
      assert.equal(current?.state, 'reserved');
      assert.equal(current?.delivery_status, 'sent');
      assert.equal(current?.token, queued.token);
      assert.match(current?.delivery_error ?? '', /desktop unavailable/);
      assert.equal(store.claim(queued.id, queued.token ?? '').state, 'claimed');
      const status = await command(state, ['status'], environment);
      assert.deepEqual((status as { delivery_alerts: unknown }).delivery_alerts, []);
    } finally { store.close(); }
    await delay(1_200);
    assert.equal(readFileSync(messages, 'utf8').trim().split('\n').length, 1);
  });
});

test('a different dispatcher HOME can read and deliver a shared desktop and Claude queue', async () => {
  await fixture(async (root, state, environment) => {
    const desktopTask = '10000000-0000-4000-8000-000000000944';
    const claudeTask = '10000000-0000-4000-8000-000000000945';
    const messages = join(root, 'messages');
    const opened = join(root, 'opened');
    executable(root, 'codex', `
      require('node:fs').appendFileSync(process.env.REPOQ_FIXTURE + '/messages', 'desktop queued\\n');
    `);
    executable(root, 'claude', `
      const fs = require('node:fs');
      if (process.argv[2] === 'agents') process.stdout.write('[]');
      else {
        fs.appendFileSync(process.env.REPOQ_FIXTURE + '/messages', 'claude resumed\\n');
        process.stdout.write(JSON.stringify({ type: 'result', session_id: '${claudeTask}', is_error: false }));
      }
    `);
    executable(root, 'open', `require('node:fs').writeFileSync(process.env.REPOQ_FIXTURE + '/opened', 'wrong desktop');`);
    const desktop = add(state, root, 944, desktopTask, 'codex', join(homedir(), '.codex'), true);
    const claude = add(state, root, 945, claudeTask, 'claude');
    environment.HOME = join(root, 'reader-home');
    const before = await command(state, ['status'], environment);
    assert.equal((before as { entries: Entry[] }).entries.length, 2);
    await command(state, ['start'], environment);
    await until(() => {
      const store = new Store(state);
      try {
        const entries = store.list();
        return entries.find((entry) => entry.id === desktop.id)?.delivery_status === 'sent' &&
          entries.find((entry) => entry.id === claude.id)?.delivery_status === 'sent';
      } finally { store.close(); }
    }, 'both native deliveries');
    assert.equal(existsSync(opened), false);
    assert.deepEqual(readFileSync(messages, 'utf8').trim().split('\n').sort(),
      ['claude resumed', 'desktop queued']);
    const after = await command(state, ['status'], environment);
    assert.equal((after as { entries: Entry[] }).entries.length, 2);
  });
});

test('a shared status reader is not mistaken for the dispatcher and does not defeat startup', async () => {
  await fixture(async (root, state, environment) => {
    const messages = join(root, 'messages');
    const ready = join(root, 'reader-ready');
    const release = join(root, 'reader-release');
    writeFileSync(messages, '');
    writeFileSync(release, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/messages', process.argv.at(-1) + '\\n');
    `);
    const queued = add(state, root, 5, '10000000-0000-4000-8000-000000000005');
    await running(state);

    const readerSource = `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(process.env.REPOQ_DAEMON_DATABASE, { timeout: 0 });
      database.exec('BEGIN');
      database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/pids', process.pid + '\\n');
      fs.writeFileSync(process.env.REPOQ_READER_READY, 'ready');
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.REPOQ_READER_RELEASE)) {
          clearInterval(timer);
          database.exec('ROLLBACK');
          database.close();
        }
      }, 10);
    `;
    const reader = spawn(process.execPath, ['-e', readerSource], {
      env: {
        ...environment,
        REPOQ_DAEMON_DATABASE: join(state, 'daemon.sqlite3'),
        REPOQ_READER_READY: ready,
        REPOQ_READER_RELEASE: release,
      },
      stdio: 'ignore',
    });
    const readerExit = new Promise<void>((resolveExit) => reader.once('exit', () => resolveExit()));
    await until(() => existsSync(ready), 'shared status reader');
    assert.equal(await running(state), false);

    const daemons = [
      spawn(process.execPath, [cli, '--state', state, 'serve'], { env: environment, stdio: 'ignore' }),
      spawn(process.execPath, [cli, '--state', state, 'serve'], { env: environment, stdio: 'ignore' }),
    ];
    const daemonExits = daemons.map((daemon) => new Promise<void>((resolveExit) => {
      daemon.once('exit', () => resolveExit());
    }));
    try {
      await delay(500);
      rmSync(release, { force: true });
      await readerExit;
      await until(() => readFileSync(messages, 'utf8').includes(queued.id), 'delivery after shared reader');
      assert.equal(await running(state), true);
      await command(state, ['stop'], environment);
      await Promise.race([
        Promise.all(daemonExits),
        delay(4_000, undefined, { ref: false }).then(() => {
          throw new Error('a competing dispatcher took over after stop');
        }),
      ]);
      assert.equal(await running(state), false);
      assert.equal(existsSync(join(state, 'stop')), true);
    } finally {
      for (const daemon of daemons) {
        if (daemon.exitCode === null) daemon.kill('SIGKILL');
      }
    }
  });
});

test('a new stop generation fences a dispatcher waiting between reader retries', async () => {
  await fixture(async (root, state, environment) => {
    const messages = join(root, 'messages');
    const ready = join(root, 'yield-reader-ready');
    const release = join(root, 'yield-reader-release');
    writeFileSync(messages, '');
    writeFileSync(release, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/messages', process.argv.at(-1) + '\\n');
    `);
    add(state, root, 6, '10000000-0000-4000-8000-000000000006');
    await running(state);

    const reader = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(process.env.REPOQ_DAEMON_DATABASE, { timeout: 0 });
      database.exec('BEGIN');
      database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/pids', process.pid + '\\n');
      fs.writeFileSync(process.env.REPOQ_READER_READY, 'ready');
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.REPOQ_READER_RELEASE)) {
          clearInterval(timer);
          database.exec('ROLLBACK');
          database.close();
        }
      }, 10);
    `], {
      env: {
        ...environment,
        REPOQ_DAEMON_DATABASE: join(state, 'daemon.sqlite3'),
        REPOQ_READER_READY: ready,
        REPOQ_READER_RELEASE: release,
      },
      stdio: 'ignore',
    });
    const readerExit = new Promise<void>((resolveExit) => reader.once('exit', () => resolveExit()));
    await until(() => existsSync(ready), 'reader holding a contended launch');
    const contender = spawn(process.execPath, [cli, '--state', state, 'serve'], {
      env: { ...environment, REPOQ_INTERNAL_STOP_GENERATION: '-' },
      stdio: 'ignore',
    });
    const contenderExit = new Promise<void>((resolveExit) => contender.once('exit', () => resolveExit()));
    try {
      await delay(250);
      assert.equal(contender.exitCode, null);
      await command(state, ['stop'], environment);
      rmSync(release, { force: true });
      await readerExit;
      await Promise.race([
        contenderExit,
        delay(3_000, undefined, { ref: false }).then(() => {
          throw new Error('reader-blocked dispatcher ignored a newer stop generation');
        }),
      ]);
      assert.equal(readFileSync(messages, 'utf8'), '');
      assert.equal(await running(state), false);
    } finally {
      if (contender.exitCode === null) contender.kill('SIGKILL');
    }
  });
});

test('delivery failures retain the reservation, redact the token, and require explicit retry', async () => {
  await fixture(async (root, state, environment) => {
    const fail = join(root, 'fail');
    const messages = join(root, 'messages');
    const configs = join(root, 'configs');
    const ownerConfig = join(root, 'owner-codex');
    const dispatcherConfig = join(root, 'dispatcher-codex');
    const dispatcherEnvironment = { ...environment, CODEX_HOME: dispatcherConfig };
    writeFileSync(fail, '');
    writeFileSync(messages, '');
    writeFileSync(configs, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      const message = process.argv.at(-1);
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/configs', process.env.CODEX_HOME + '\\n');
      if (fs.existsSync(process.env.REPOQ_FIXTURE + '/fail')) {
        process.stderr.write('failed token from message: ' + message);
        process.exit(7);
      }
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/messages', message + '\\n');
    `);
    const first = add(
      state,
      root,
      10,
      '10000000-0000-4000-8000-000000000010',
      'codex',
      ownerConfig,
    );
    const queue = new Store(state);
    const second = queue.add({
      url: 'https://github.com/fixture/repository-10/pull/11',
      agent: 'codex',
      task: '10000000-0000-4000-8000-000000000011',
      cwd: root,
      owner_config_root: ownerConfig,
    });
    queue.close();
    await command(state, ['start'], dispatcherEnvironment);

    await until(() => {
      const probe = new Store(state);
      try { return probe.list()[0]?.delivery_status === 'failed'; } finally { probe.close(); }
    }, 'failed delivery');
    const probe = new Store(state);
    const failed = probe.list();
    probe.close();
    assert.equal(failed[0]?.state, 'reserved');
    assert.equal(failed[0]?.token, first.token);
    assert.equal(failed[1]?.state, 'waiting');
    assert.doesNotMatch(failed[0]?.delivery_error ?? '', new RegExp(first.token ?? 'never'));
    assert.deepEqual(readFileSync(configs, 'utf8').trim().split('\n'), [ownerConfig]);

    unlinkSync(fail);
    const retry = new Store(state);
    const replacement = retry.retry(first.id, first.token ?? '');
    retry.close();
    assert.notEqual(replacement.token, first.token);
    await until(() => readFileSync(messages, 'utf8').includes(replacement.token ?? 'missing-token'), 'retried wake');
    assert.deepEqual(readFileSync(configs, 'utf8').trim().split('\n'), [ownerConfig, ownerConfig]);
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
    const finishes = join(root, 'finishes');
    const gate = join(root, 'gate');
    writeFileSync(starts, '');
    writeFileSync(finishes, '');
    writeFileSync(gate, '');
    executable(root, 'codex', `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const task = args[args.indexOf('--thread') + 1];
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/starts', task + '\\n');
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.REPOQ_FIXTURE + '/gate')) {
          clearInterval(timer);
          fs.appendFileSync(process.env.REPOQ_FIXTURE + '/finishes', task + '\\n');
          process.exit(0);
        }
      }, 20);
    `);
    const sharedTask = '10000000-0000-4000-8000-000000000030';
    const recoveredWhileLive = add(state, root, 30, sharedTask);
    add(state, root, 31, sharedTask);
    let retriedWhileLive: Entry | undefined;
    for (let number = 32; number <= 35; number += 1) {
      const queued = add(state, root, number, `10000000-0000-4000-8000-0000000000${number}`);
      if (number === 32) retriedWhileLive = queued;
    }
    await command(state, ['start'], environment);
    await until(() => readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).length === 4, 'four concurrent deliveries');

    const active = new Store(state);
    const statuses = active.list().map((entry) => entry.delivery_status);
    active.close();
    assert.equal(statuses.filter((status) => status === 'sending').length, 4);
    assert.equal(statuses.filter((status) => status === 'pending').length, 2);
    assert.equal(readFileSync(starts, 'utf8').trim().split('\n').filter((owner) => owner === sharedTask).length, 1);

    const transitions = new Store(state);
    transitions.claim(recoveredWhileLive.id, recoveredWhileLive.token ?? '');
    transitions.close();

    await command(state, ['stop'], environment);
    await command(state, ['start'], environment);
    assert.ok(retriedWhileLive?.token);
    await command(state, ['recover', recoveredWhileLive.id, `--token=${recoveredWhileLive.token ?? ''}`, '--quiescent'], environment);
    await command(state, ['retry', retriedWhileLive.id, `--token=${retriedWhileLive.token}`], environment);
    await delay(1_250);
    assert.equal(readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).length, 4);

    await command(state, ['stop'], environment);
    unlinkSync(gate);
    await until(() => readFileSync(finishes, 'utf8').trim().split('\n').filter(Boolean).length === 4, 'orphaned delivery exits');
    await command(state, ['start'], environment);
    await until(() => readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).length === 8, 'remaining serialized deliveries');
  });
});

test('timed-out delivery cleanup stays bounded and does not retain a stopped dispatcher', async () => {
  await fixture(async (root, state, environment) => {
    const starts = join(root, 'timeout-starts');
    const signals = join(root, 'timeout-signals');
    const finishes = join(root, 'timeout-finishes');
    const gate = join(root, 'timeout-gate');
    const clock = join(root, 'short-timeout.cjs');
    for (const path of [starts, signals, finishes, gate]) writeFileSync(path, '');
    writeFileSync(clock, `
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        value: () => nativeTimeout(500),
        writable: true,
      });
    `);
    executable(root, 'codex', `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const task = args[args.indexOf('--thread') + 1];
      fs.appendFileSync(process.env.REPOQ_FIXTURE + '/pids', process.pid + '\\n');
      fs.appendFileSync(${JSON.stringify(starts)}, task + ':' + process.pid + '\\n');
      let stopping = false;
      process.on('SIGTERM', () => {
        if (stopping) return;
        stopping = true;
        fs.appendFileSync(${JSON.stringify(signals)}, task + ':' + process.pid + '\\n');
      });
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(gate)})) {
          clearInterval(timer);
          fs.appendFileSync(${JSON.stringify(finishes)}, task + ':' + process.pid + '\\n');
          process.exit(0);
        }
      }, 20);
    `);
    const timedEnvironment = {
      ...environment,
      NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ''} --require=${clock}`.trim(),
    };
    const sharedTask = '10000000-0000-4000-8000-000000000050';
    add(state, root, 50, sharedTask);
    add(state, root, 51, sharedTask);
    for (let number = 52; number <= 56; number += 1) {
      add(state, root, number, `10000000-0000-4000-8000-0000000000${number}`);
    }

    const daemon = spawn(process.execPath, [cli, '--state', state, 'serve'], {
      env: timedEnvironment,
      stdio: 'ignore',
    });
    const daemonExit = new Promise<void>((resolveExit) => daemon.once('exit', () => resolveExit()));
    try {
      await until(
        () => readFileSync(signals, 'utf8').trim().split('\n').filter(Boolean).length === 4,
        'four timed-out deliveries entering cleanup',
      );
      await delay(1_250);
      const started = readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(started.length, 4);
      assert.equal(started.filter((line) => line.startsWith(`${sharedTask}:`)).length, 1);
      const livePids = started.map((line) => Number(line.slice(line.lastIndexOf(':') + 1)));
      assert.equal(livePids.length, 4);
      for (const pid of livePids) assert.doesNotThrow(() => process.kill(pid, 0));

      const queue = new Store(state);
      const statuses = queue.list().map((entry) => entry.delivery_status);
      queue.close();
      assert.equal(statuses.filter((status) => status === 'sending').length, 4);
      assert.equal(statuses.filter((status) => status === 'pending').length, 3);

      await command(state, ['stop'], timedEnvironment);
      await Promise.race([
        daemonExit,
        delay(3_000, undefined, { ref: false }).then(() => {
          throw new Error('dispatcher remained attached to timed-out delivery cleanup');
        }),
      ]);
      for (const pid of livePids) assert.doesNotThrow(() => process.kill(pid, 0));
      assert.equal(readFileSync(finishes, 'utf8'), '');

      unlinkSync(gate);
      await until(
        () => readFileSync(finishes, 'utf8').trim().split('\n').filter(Boolean).length === 4,
        'timed-out delivery cleanup completion',
      );
      assert.equal(readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).length, 4);
    } finally {
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
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

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { deliver } from '../src/adapters.ts';
import { claudePidDomain } from '../src/claude-messaging.ts';
import type { Entry } from '../src/types.ts';

const task = '10000000-0000-4000-8000-000000000001';
const token = 'private-delivery-token';

function entry(agent: Entry['agent']): Entry {
  return {
    sequence: 1,
    id: '20000000-0000-4000-8000-000000000002',
    url: 'https://github.com/fixture/repository/pull/1',
    provider: 'github',
    repo: 'github.com/fixture/repository',
    pr_number: 1,
    agent,
    task,
    cwd: tmpdir(),
    state: 'reserved',
    token,
    block_reason: '',
    delivery_status: 'sending',
    delivery_error: '',
    created_at: '2026-09-14T00:00:00.000000+00:00',
    updated_at: '2026-09-14T00:00:00.000000+00:00',
  };
}

function executable(directory: string, name: string, source: string): void {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'repoq-adapters-'));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
    await run(directory);
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function until(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('Codex receives the exact task and the wake message as one argument', async () => {
  await fixture(async (directory) => {
    const capture = join(directory, 'capture.json');
    process.env.REPOQ_CAPTURE = capture;
    executable(directory, 'codex', `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.REPOQ_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
    `);
    const message = 'claim entry; $(never execute this)';
    const lifecycle: (string | number)[] = [];
    await deliver(entry('codex'), message, undefined, {
      beforeSpawn: () => { lifecycle.push('before'); },
      spawned: (pid) => { lifecycle.push(pid); },
    });
    const observed: unknown = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(observed, {
      args: ['queue', '--thread', task, '--message', message],
      cwd: realpathSync(tmpdir()),
    });
    assert.equal(lifecycle[0], 'before');
    assert.ok(typeof lifecycle[1] === 'number' && lifecycle[1] > 1);
    assert.equal(lifecycle.length, 2);
    delete process.env.REPOQ_CAPTURE;
  });
});

test('a live Claude owner receives one exact native SendMessage call', async () => {
  await fixture(async (directory) => {
    const capture = join(directory, 'calls');
    const discoveryCwd = join(directory, 'discovery-cwd');
    const owner = join(directory, 'owner');
    const config = 'claude-config';
    const sessions = join(owner, config, 'sessions');
    const sockets = join(directory, 'sockets');
    mkdirSync(owner, { mode: 0o700 });
    mkdirSync(sessions, { mode: 0o700, recursive: true });
    mkdirSync(sockets, { mode: 0o700 });
    const socket = join(sockets, 'target.sock');
    const address = `uds:${socket}`;
    const message = 'wake exactly; $(never execute this)';
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    chmodSync(socket, 0o600);
    process.env.REPOQ_CAPTURE = capture;
    process.env.REPOQ_DISCOVERY_CWD = discoveryCwd;
    process.env.CLAUDE_CONFIG_DIR = config;
    writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId: task,
      cwd: owner,
      messagingSocketPath: socket,
      peerProtocol: 1,
      procStart: 'fixture-process-start',
      pidDomain: claudePidDomain(),
    }), { mode: 0o600 });
    executable(directory, 'claude', `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.REPOQ_CAPTURE, JSON.stringify(args) + '\\n');
      if (args[0] === 'agents') {
        fs.writeFileSync(process.env.REPOQ_DISCOVERY_CWD, process.cwd());
        process.stdout.write(JSON.stringify([{ sessionId: '${task}', pid: ${process.pid}, cwd: ${JSON.stringify(owner)} }]));
      } else {
        const useId = 'toolu_fixture';
        const events = [
          { type: 'system', subtype: 'init', tools: ['SendMessage'], permissionMode: 'bypassPermissions' },
          { type: 'assistant', message: { content: [{ type: 'tool_use', id: useId, name: 'SendMessage', input: { to: ${JSON.stringify(address)}, message: ${JSON.stringify(message)} } }] } },
          { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: useId, content: [{ type: 'text', text: JSON.stringify({ success: true, msg_id: 'native-message-id' }) }] }] } },
          { type: 'result', is_error: false },
        ];
        process.stdout.write(events.map(JSON.stringify).join('\\n'));
      }
    `);
    try {
      await deliver({ ...entry('claude'), cwd: owner }, message);
      const calls: unknown[] = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], ['agents', '--json']);
      assert.equal(readFileSync(discoveryCwd, 'utf8'), realpathSync(owner));
      assert.notEqual(realpathSync(process.cwd()), realpathSync(owner));
      const sender = calls[1];
      assert.ok(Array.isArray(sender));
      assert.deepEqual(sender.slice(0, 13), [
        '-p', '--safe-mode', '--tools', 'SendMessage',
        '--permission-prompts', 'none', '--no-session-persistence',
        '--max-turns', '3', '--output-format', 'stream-json', '--verbose', '--',
      ]);
      const prompt = sender[13];
      assert.equal(typeof prompt, 'string');
      assert.match(prompt, new RegExp(JSON.stringify(address).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(prompt, /SendMessage exactly once/);
    } finally {
      delete process.env.REPOQ_CAPTURE;
      delete process.env.REPOQ_DISCOVERY_CWD;
      delete process.env.CLAUDE_CONFIG_DIR;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('Claude accepts ordinary and verbose success output for the exact exited owner', async (context) => {
  const result = {
    type: 'result',
    subtype: 'success',
    session_id: task,
    is_error: false,
    result: 'wake accepted',
  };
  const cases: readonly { readonly name: string; readonly output: unknown }[] = [
    { name: 'ordinary result object', output: result },
    {
      name: 'verbose event array',
      output: [
        { type: 'system', subtype: 'init', session_id: task },
        { type: 'assistant', message: { role: 'assistant', content: [] }, session_id: task },
        result,
      ],
    },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      await fixture(async (directory) => {
        const capture = join(directory, 'resume.json');
        process.env.REPOQ_CAPTURE = capture;
        executable(directory, 'claude', `
          const fs = require('node:fs');
          const args = process.argv.slice(2);
          if (args[0] === 'agents') process.stdout.write('[]');
          else {
            fs.writeFileSync(process.env.REPOQ_CAPTURE, JSON.stringify({ args, cwd: process.cwd() }));
            process.stdout.write(${JSON.stringify(JSON.stringify(item.output))});
          }
        `);
        try {
          await deliver(entry('claude'), 'wake');
          const observed: unknown = JSON.parse(readFileSync(capture, 'utf8'));
          assert.deepEqual(observed, {
            args: [
              '-p', '--resume', task, '--output-format', 'json',
              '--permission-prompts', 'none', '--', 'wake',
            ],
            cwd: realpathSync(tmpdir()),
          });
        } finally {
          delete process.env.REPOQ_CAPTURE;
        }
      });
    });
  }
});

test('Claude response must end with one result for the exact session and explicit success', async (context) => {
  const cases: readonly { readonly name: string; readonly output: unknown }[] = [
    { name: 'ordinary result without explicit success', output: { session_id: task } },
    {
      name: 'verbose result for another session',
      output: [{ type: 'result', subtype: 'success', session_id: 'different-session', is_error: false }],
    },
    {
      name: 'verbose result followed by another event',
      output: [
        { type: 'result', subtype: 'success', session_id: task, is_error: false },
        { type: 'assistant', message: { role: 'assistant', content: [] } },
      ],
    },
    {
      name: 'verbose output with duplicate results',
      output: [
        { type: 'result', subtype: 'success', session_id: task, is_error: false },
        { type: 'result', subtype: 'success', session_id: task, is_error: false },
      ],
    },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      await fixture(async (directory) => {
        executable(directory, 'claude', `
          if (process.argv[2] === 'agents') process.stdout.write('[]');
          else process.stdout.write(${JSON.stringify(JSON.stringify(item.output))});
        `);
        await assert.rejects(deliver(entry('claude'), 'wake'), /requested session/);
      });
    });
  }
});

test('adapter failures redact ownership tokens and bound captured output', async () => {
  await fixture(async (directory) => {
    executable(directory, 'codex', `
      process.stderr.write('${token}');
      process.stderr.write('x'.repeat(2 * 1024 * 1024));
    `);
    const error = await deliver(entry('codex'), 'wake').then(
      () => undefined,
      (failure: unknown) => failure,
    );
    assert(error instanceof Error);
    assert.match(error.message, /output exceeded 1048576 bytes/);
    assert.doesNotMatch(error.message, new RegExp(token));
  });
});

test('a timeout remains tracked until delayed SIGTERM cleanup closes the child', async () => {
  await fixture(async (directory) => {
    const signaled = join(directory, 'signaled');
    const finished = join(directory, 'finished');
    executable(directory, 'codex', `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(signaled)}, 'yes');
        setTimeout(() => {
          fs.writeFileSync(${JSON.stringify(finished)}, 'yes');
          process.exit(0);
        }, 250);
      });
      setInterval(() => {}, 1000);
    `);

    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    assert(timeoutDescriptor);
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    Object.defineProperty(AbortSignal, 'timeout', {
      ...timeoutDescriptor,
      value: (_milliseconds: number) => nativeTimeout(500),
    });
    let settled = false;
    try {
      const delivery = deliver(entry('codex'), 'wake').then(
        () => { settled = true; return { status: 'resolved' as const }; },
        (error: unknown) => { settled = true; return { status: 'rejected' as const, error }; },
      );
      await until(() => existsSync(signaled), 'delivery timeout signal');
      assert.equal(settled, false);
      assert.equal(existsSync(finished), false);
      const outcome = await delivery;
      assert.equal(outcome.status, 'rejected');
      assert('error' in outcome && outcome.error instanceof Error);
      assert.match(outcome.error.message, /aborted/i);
      assert.equal(readFileSync(finished, 'utf8'), 'yes');
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });
});

test('a child registration failure remains tracked until the spawned process closes', async () => {
  await fixture(async (directory) => {
    const ready = join(directory, 'registration-ready');
    const signaled = join(directory, 'registration-signaled');
    const finished = join(directory, 'registration-finished');
    const gate = join(directory, 'registration-gate');
    writeFileSync(gate, '');
    executable(directory, 'codex', `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(signaled)}, 'yes');
      });
      fs.writeFileSync(${JSON.stringify(ready)}, 'yes');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(gate)})) {
          clearInterval(timer);
          fs.writeFileSync(${JSON.stringify(finished)}, 'yes');
          process.exit(0);
        }
      }, 20);
    `);

    let settled = false;
    const delivery = deliver(entry('codex'), 'wake', undefined, {
      beforeSpawn: () => {},
      spawned: () => {
        const deadline = Date.now() + 2_000;
        while (!existsSync(ready) && Date.now() < deadline) { /* child initializes independently */ }
        assert.equal(existsSync(ready), true);
        throw new Error('fixture ledger write failed');
      },
    }).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await until(() => existsSync(ready), 'registered child initialization');
    assert.equal(settled, false);
    assert.equal(existsSync(signaled), false);
    assert.equal(existsSync(finished), false);
    rmSync(gate);
    const error = await delivery;
    assert(error instanceof Error);
    assert.match(error.message, /fixture ledger write failed/);
    assert.equal(readFileSync(finished, 'utf8'), 'yes');
    assert.equal(existsSync(signaled), false);
  });
});

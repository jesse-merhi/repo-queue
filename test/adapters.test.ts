import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { deliver } from '../src/adapters.ts';
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

test('Codex receives the exact task and the wake message as one argument', async () => {
  await fixture(async (directory) => {
    const capture = join(directory, 'capture.json');
    process.env.REPOQ_CAPTURE = capture;
    executable(directory, 'codex', `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.REPOQ_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
    `);
    const message = 'claim entry; $(never execute this)';
    await deliver(entry('codex'), message);
    const observed: unknown = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(observed, {
      args: ['queue', '--thread', task, '--message', message],
      cwd: realpathSync(tmpdir()),
    });
    delete process.env.REPOQ_CAPTURE;
  });
});

test('a live Claude owner is rejected before resume', async () => {
  await fixture(async (directory) => {
    const capture = join(directory, 'calls');
    process.env.REPOQ_CAPTURE = capture;
    executable(directory, 'claude', `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.REPOQ_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
      process.stdout.write(JSON.stringify([{ sessionId: '${task}' }]));
    `);
    await assert.rejects(deliver(entry('claude'), 'wake'), /still running/);
    assert.deepEqual(readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
      ['agents', '--json'],
    ]);
    delete process.env.REPOQ_CAPTURE;
  });
});

test('Claude resumes the exact exited owner in its original directory', async () => {
  await fixture(async (directory) => {
    const capture = join(directory, 'resume.json');
    process.env.REPOQ_CAPTURE = capture;
    executable(directory, 'claude', `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args[0] === 'agents') process.stdout.write('[]');
      else {
        fs.writeFileSync(process.env.REPOQ_CAPTURE, JSON.stringify({ args, cwd: process.cwd() }));
        process.stdout.write(JSON.stringify({ session_id: '${task}', is_error: false }));
      }
    `);
    await deliver(entry('claude'), 'wake');
    const observed: unknown = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(observed, {
      args: [
        '-p', '--resume', task, '--output-format', 'json',
        '--permission-prompts', 'none', '--', 'wake',
      ],
      cwd: realpathSync(tmpdir()),
    });
    delete process.env.REPOQ_CAPTURE;
  });
});

test('Claude response must identify the exact session and explicit success', async () => {
  await fixture(async (directory) => {
    executable(directory, 'claude', `
      if (process.argv[2] === 'agents') process.stdout.write('[]');
      else process.stdout.write(JSON.stringify({ session_id: '${task}' }));
    `);
    await assert.rejects(deliver(entry('claude'), 'wake'), /requested session/);
  });
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

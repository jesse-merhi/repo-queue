import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { deliver } from './adapters.ts';
import { Store } from './store.ts';
import type { Entry } from './types.ts';

const daemonDatabase = 'daemon.sqlite3';
const legacyLock = 'dispatcher.lock';
const stopRequest = 'stop';
const deliveryLimit = 4;
const daemonAcquireTimeoutMs = 2_000;

function prepareState(state: string): string {
  const stateDirectory = resolve(state);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  return stateDirectory;
}

function assertLegacyDispatcherRemoved(state: string): void {
  const marker = resolve(state, legacyLock);
  if (existsSync(marker)) {
    throw new Error(
      `Legacy Python dispatcher marker exists at ${marker}. Stop the Python dispatcher, ` +
      'verify it is stopped, then rename or remove dispatcher.lock before starting the Node dispatcher',
    );
  }
}

function sqliteBusy(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'errcode') === 5;
}

function openDaemonDatabase(state: string, timeout: number): DatabaseSync {
  const path = resolve(state, daemonDatabase);
  const database = new DatabaseSync(path, { timeout });
  chmodSync(path, 0o600);
  database.exec(`PRAGMA busy_timeout = ${timeout}`);
  return database;
}

function acquire(state: string): DatabaseSync | undefined {
  const database = openDaemonDatabase(state, daemonAcquireTimeoutMs);
  try {
    database.exec('BEGIN EXCLUSIVE');
    return database;
  } catch (error) {
    database.close();
    if (sqliteBusy(error)) return undefined;
    throw error;
  }
}

/** Probe the durable singleton lease without relying on process IDs or stale files. */
export async function running(state: string): Promise<boolean> {
  const stateDirectory = prepareState(state);
  assertLegacyDispatcherRemoved(stateDirectory);
  const database = openDaemonDatabase(stateDirectory, 0);
  try {
    database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
    return false;
  } catch (error) {
    if (sqliteBusy(error)) return true;
    throw error;
  } finally {
    database.close();
  }
}

function executableArguments(state: string): readonly [string, readonly string[]] {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('Cannot locate the RepoQ executable entrypoint');
  return [process.execPath, [resolve(entrypoint), '--state', state, 'serve']];
}

/** Start a detached copy of the same built CLI executable. Concurrent starts are harmless. */
export async function start(state: string): Promise<void> {
  const stateDirectory = prepareState(state);
  assertLegacyDispatcherRemoved(stateDirectory);
  if (await running(stateDirectory)) return;

  const log = openSync(resolve(stateDirectory, 'dispatcher.log'), 'a', 0o600);
  const [command, args] = executableArguments(stateDirectory);
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', log, log],
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  }).finally(() => closeSync(log));
  child.unref();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await running(stateDirectory)) return;
    await delay(50);
  }
  throw new Error('Dispatcher did not start; inspect dispatcher.log');
}

/** Request shutdown without releasing reservations or terminating agent processes. */
export async function stop(state: string): Promise<void> {
  const stateDirectory = prepareState(state);
  if (await running(stateDirectory)) writeFileSync(resolve(stateDirectory, stopRequest), '', { mode: 0o600 });
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Build the fenced instructions sent to the owning conversation. */
export function wakeMessage(entry: Entry, state: string): string {
  if (!entry.token) throw new Error('Reserved queue entry has no ownership token');
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('Cannot locate the RepoQ executable entrypoint');
  const command = [process.execPath, resolve(entrypoint), '--state', resolve(state)].map(shellWord).join(' ');
  const claim = [entry.id, '--token', entry.token].map(shellWord).join(' ');
  return `Your PR ${entry.url} has the repository turn. First run: ${command} claim ${claim}. ` +
    'Proceed only if that claim succeeds. Duplicate or stale wake messages grant no turn. ' +
    'Then finish your existing authorized merge workflow, including its reviews, approvals, CI and verification. ' +
    'This message grants no new merge, publication or spending authority. ' +
    `After completion and after all remote jobs have finished, run: ${command} done ${claim}. ` +
    `If blocked, run: ${command} block ${claim} --reason <reason>, report the blocker and end your turn. ` +
    'Blocking retains your reservation. Do not poll or wake another conversation.';
}

function safeError(error: unknown, token: string | null): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = token ? message.split(token).join('<redacted>') : message;
  return redacted.slice(0, 4_096);
}

async function sendEntry(entry: Entry, state: string, releaseSignal: AbortSignal): Promise<void> {
  const store = new Store(state);
  try {
    try {
      await deliver(entry, wakeMessage(entry, state), releaseSignal);
      store.delivery(entry.id, entry.token ?? '', true, '');
    } catch (error) {
      store.delivery(entry.id, entry.token ?? '', false, safeError(error, entry.token));
    }
  } finally {
    store.close();
  }
}

/** Run the exclusive dispatcher until a stop request is observed. */
export async function serve(state: string): Promise<void> {
  process.umask(0o077);
  const stateDirectory = prepareState(state);
  assertLegacyDispatcherRemoved(stateDirectory);
  const lease = acquire(stateDirectory);
  if (!lease) return;

  const stopPath = resolve(stateDirectory, stopRequest);
  rmSync(stopPath, { force: true });
  const store = new Store(stateDirectory);
  const activeOwners = new Map<string, Promise<void>>();
  const deliveryLifecycle = new AbortController();
  try {
    store.markUncertain();
    while (!existsSync(stopPath)) {
      store.reserve();
      for (const entry of store.pendingNotifications()) {
        if (activeOwners.size >= deliveryLimit) break;
        const owner = `${entry.agent}\0${entry.task}`;
        if (activeOwners.has(owner) || !entry.token || !store.beginDelivery(entry.id, entry.token)) continue;
        const task = sendEntry(entry, stateDirectory, deliveryLifecycle.signal)
          .catch((error: unknown) => {
            process.stderr.write(`repo-queue: delivery bookkeeping failed: ${safeError(error, entry.token)}\n`);
          })
          .finally(() => { activeOwners.delete(owner); });
        activeOwners.set(owner, task);
      }
      await delay(1_000);
    }
  } finally {
    deliveryLifecycle.abort();
    rmSync(stopPath, { force: true });
    store.close();
    lease.exec('ROLLBACK');
    lease.close();
  }
}

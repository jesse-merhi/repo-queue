import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorNative } from './native-monitor.ts';
import { activateCodexTask, deliver } from './adapters.ts';
import { overdueCodexClaims } from './claim-watch.ts';
import { DeliveryLedger, type DeliveryAttempt } from './delivery-ledger.ts';
import { Store } from './store.ts';
import type { Entry } from './types.ts';

const daemonDatabase = 'daemon.sqlite3';
const legacyLock = 'dispatcher.lock';
const stopRequest = 'stop';
const daemonAcquireDeadlineMs = 2_000;
const daemonStopDeadlineMs = 5_000;
const internalStopGeneration = 'REPOQ_INTERNAL_STOP_GENERATION';
const missingStopGeneration = '-';

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

function tryAcquire(state: string): DatabaseSync | undefined {
  const database = openDaemonDatabase(state, 0);
  try {
    database.exec('BEGIN EXCLUSIVE');
    return database;
  } catch (error) {
    database.close();
    if (sqliteBusy(error)) return undefined;
    throw error;
  }
}

function probe(state: string): boolean {
  const database = openDaemonDatabase(state, 0);
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

function stopGeneration(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function publishStopGeneration(path: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, randomUUID(), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function expectedStopGeneration(path: string): string | undefined {
  const inherited = process.env[internalStopGeneration];
  delete process.env[internalStopGeneration];
  if (inherited === undefined) return stopGeneration(path);
  return inherited === missingStopGeneration ? undefined : inherited;
}

function release(database: DatabaseSync): void {
  database.exec('ROLLBACK');
  database.close();
}

async function acquire(state: string, stopped: () => boolean): Promise<DatabaseSync | undefined> {
  const deadline = Date.now() + daemonAcquireDeadlineMs;
  while (true) {
    if (stopped()) return undefined;
    const database = tryAcquire(state);
    if (database) {
      if (!stopped()) return database;
      release(database);
      return undefined;
    }
    if (probe(state)) return undefined;
    if (stopped()) return undefined;
    if (Date.now() >= deadline) return undefined;
    await delay(25);
  }
}

/** Probe the durable singleton lease without relying on process IDs or stale files. */
export async function running(state: string): Promise<boolean> {
  const stateDirectory = prepareState(state);
  assertLegacyDispatcherRemoved(stateDirectory);
  return probe(stateDirectory);
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
  const generation = stopGeneration(resolve(stateDirectory, stopRequest));

  const log = openSync(resolve(stateDirectory, 'dispatcher.log'), 'a', 0o600);
  const [command, args] = executableArguments(stateDirectory);
  const child = spawn(command, args, {
    detached: true,
    env: {
      ...process.env,
      [internalStopGeneration]: generation ?? missingStopGeneration,
    },
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
  publishStopGeneration(resolve(stateDirectory, stopRequest));
  const deadline = Date.now() + daemonStopDeadlineMs;
  while (Date.now() < deadline) {
    if (!probe(stateDirectory)) return;
    await delay(50);
  }
  throw new Error('Dispatcher did not stop; inspect dispatcher.log');
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
  const claim = [entry.id, `--token=${entry.token}`].map(shellWord).join(' ');
  const owner = ['--agent', entry.agent, '--task', entry.task, '--cwd', entry.cwd].map(shellWord).join(' ');
  if (entry.native !== undefined) {
    return `GitHub queue work for ${entry.url} needs its original owner. Provider state: ${entry.native.state}. ` +
      `Evidence: ${JSON.stringify(entry.native.detail)}. This is a repair turn, not a repository merge lock. ` +
      `First run: ${command} claim ${claim}. If already claimed, run: ${command} verify-claim ${claim} ${owner}. ` +
      'Continue only after successful ownership verification. Preserve the authorized PR/stack scope and all technical review and security gates. ' +
      (entry.checkpoint_path === undefined ? '' : `Read the workflow checkpoint at ${JSON.stringify(entry.checkpoint_path)}. `) +
      'The saved explicit queue authorization covers its required validation and merge; do not ask again for routine queue validation. ' +
      'Diagnose and repair readiness failures in this original conversation. Do not merge directly or acquire a repository lock. ' +
      `After repairs and verification run: ${command} resume-native ${claim}. ` +
      'For an uncertain submission, first establish that the remote request has finished or cannot execute, then add --quiescent. ' +
      `If blocked, run: ${command} block ${claim} --reason <reason>. ` +
      'GitHub owns ordering, combined validation, ejection and merge; accepted messages or requests do not prove success.';
  }
  return `Your PR ${entry.url} has the repository turn. On the first wake run: ${command} claim ${claim}. ` +
    'Save its successful result. If this conversation already claimed this entry, do not claim again; ' +
    `confirm this is your original conversation and worktree, then run: ${command} verify-claim ${claim} ${owner}. ` +
    'A successful verification permits continuing your existing claimed workflow, including after compaction. ' +
    'Proceed only with a successful first claim or verified existing claim. A stale token or different owner grants no turn. ' +
    'Ignore duplicate notifications without abandoning verified work already in progress. ' +
    (entry.checkpoint_path === undefined ? '' :
      `After claim verification, read the workflow checkpoint at ${JSON.stringify(entry.checkpoint_path)}. ` +
      'Use it to recover existing jobs and the next action; verify its candidate and evidence before continuing. ' +
      'If it is missing or stale, reconstruct the current state before merge work. ' +
      'A saved review assignment is context, not code-review approval; assess changed integration before choosing what to review. ') +
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

async function sendEntry(
  entry: Entry,
  state: string,
  releaseSignal: AbortSignal,
  ledger: DeliveryLedger,
  attempt: DeliveryAttempt,
): Promise<void> {
  const store = new Store(state);
  try {
    try {
      const lifecycle = {
        beforeSpawn: () => { ledger.beforeSpawn(attempt); },
        spawned: (pid: number) => { ledger.spawned(attempt, pid); },
      };
      await deliver(entry, wakeMessage(entry, state), releaseSignal, lifecycle);
      store.delivery(entry.id, entry.token ?? '', true, '');
      try {
        await activateCodexTask(entry, releaseSignal, lifecycle);
      } catch (error) {
        store.activationError(entry.id, entry.token ?? '', safeError(error, entry.token));
      }
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
  const stopPath = resolve(stateDirectory, stopRequest);
  const expectedGeneration = expectedStopGeneration(stopPath);
  const stopped = (): boolean => stopGeneration(stopPath) !== expectedGeneration;
  const lease = await acquire(stateDirectory, stopped);
  if (!lease) return;

  const store = new Store(stateDirectory);
  const admissionLedger = new DeliveryLedger(stateDirectory);
  let nativePass: Promise<void> | undefined;
  const activeOwners = new Map<string, Promise<void>>();
  const reportedClaims = new Map<string, string>();
  const deliveryLifecycle = new AbortController();
  try {
    store.markUncertain();
    while (!stopped()) {
      if (nativePass === undefined) {
        const nativeStore = new Store(stateDirectory);
        nativePass = monitorNative(nativeStore, undefined, stopped)
          .catch(() => { process.stderr.write('repo-queue: native monitoring failed; inspect durable state\n'); })
          .finally(() => { nativeStore.close(); nativePass = undefined; });
      }
      admissionLedger.reconcile();
      store.reserve();
      const claimAlerts = overdueCodexClaims(store.acceptedCodexWakes());
      const currentAlerts = new Set(claimAlerts.map((alert) => alert.entry_id));
      for (const entryId of reportedClaims.keys()) {
        if (!currentAlerts.has(entryId)) reportedClaims.delete(entryId);
      }
      for (const alert of claimAlerts) {
        if (reportedClaims.get(alert.entry_id) === alert.accepted_at) continue;
        reportedClaims.set(alert.entry_id, alert.accepted_at);
        process.stderr.write(`repo-queue: ${alert.code} for entry ${alert.entry_id}, task ${alert.task}: ${alert.message}\n`);
      }
      for (const entry of store.pendingNotifications()) {
        const owner = `${entry.agent}\0${entry.task}`;
        if (activeOwners.has(owner) || !entry.token) continue;
        const attempt = admissionLedger.admit(entry, process.pid);
        if (attempt === undefined) continue;
        let attemptLedger: DeliveryLedger;
        try {
          attemptLedger = new DeliveryLedger(stateDirectory);
        } catch (error) {
          admissionLedger.release(attempt);
          throw error;
        }
        let deliveryStarted: boolean;
        try {
          deliveryStarted = store.beginDelivery(entry.id, entry.token);
        } catch (error) {
          try { attemptLedger.release(attempt); } finally { attemptLedger.close(); }
          throw error;
        }
        if (!deliveryStarted) {
          try { attemptLedger.release(attempt); } finally { attemptLedger.close(); }
          continue;
        }
        const task = sendEntry(entry, stateDirectory, deliveryLifecycle.signal, attemptLedger, attempt)
          .catch((error: unknown) => {
            process.stderr.write(`repo-queue: delivery bookkeeping failed: ${safeError(error, entry.token)}\n`);
          })
          .finally(() => {
            try {
              attemptLedger.release(attempt);
            } catch (error) {
              process.stderr.write(`repo-queue: delivery ledger release failed: ${safeError(error, entry.token)}\n`);
            } finally {
              attemptLedger.close();
              activeOwners.delete(owner);
            }
          });
        activeOwners.set(owner, task);
      }
      await delay(1_000);
    }
  } finally {
    deliveryLifecycle.abort();
    admissionLedger.close();
    store.close();
    release(lease);
  }
}

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Entry } from './types.ts';

const deliveryDatabase = 'delivery.sqlite3';
const deliveryLimit = 4;

interface AttemptRow {
  readonly attempt_id: string;
  readonly slot: number;
  readonly entry_id: string;
  readonly token: string;
  readonly dispatcher_pid: number;
  readonly child_pid: number | null;
}

export interface DeliveryAttempt {
  readonly id: string;
  readonly entryId: string;
  readonly token: string;
  readonly dispatcherPid: number;
}

export interface DeliveryAttemptStatus {
  readonly entry_id: string;
  readonly dispatcher_pid: number;
  readonly child_pid: number | null;
}

function row(value: unknown): AttemptRow {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid delivery attempt');
  const attemptId = Reflect.get(value, 'attempt_id');
  const slot = Reflect.get(value, 'slot');
  const entryId = Reflect.get(value, 'entry_id');
  const token = Reflect.get(value, 'token');
  const dispatcherPid = Reflect.get(value, 'dispatcher_pid');
  const childPid = Reflect.get(value, 'child_pid');
  if (
    typeof attemptId !== 'string' || typeof entryId !== 'string' || typeof token !== 'string' ||
    typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0 || slot >= deliveryLimit ||
    typeof dispatcherPid !== 'number' || !Number.isSafeInteger(dispatcherPid) || dispatcherPid <= 0 ||
    (childPid !== null && (typeof childPid !== 'number' || !Number.isSafeInteger(childPid) || childPid <= 1))
  ) throw new Error('Invalid delivery attempt');
  return { attempt_id: attemptId, slot, entry_id: entryId, token, dispatcher_pid: dispatcherPid, child_pid: childPid };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ESRCH') return false;
    if (error instanceof Error && Reflect.get(error, 'code') === 'EPERM') return true;
    throw error;
  }
}

/** Private durable accounting for delivery processes that can outlive a dispatcher. */
export class DeliveryLedger {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(state: string) {
    const directory = resolve(state);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!statSync(directory).isDirectory()) throw new Error(`state path is not a directory: ${directory}`);
    chmodSync(directory, 0o700);
    this.databasePath = join(directory, deliveryDatabase);
    this.database = new DatabaseSync(this.databasePath, { timeout: 30_000 });
    try {
      this.database.exec('PRAGMA busy_timeout = 30000');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS attempts (
          attempt_id TEXT PRIMARY KEY,
          slot INTEGER NOT NULL UNIQUE CHECK (slot >= 0 AND slot < ${deliveryLimit}),
          agent TEXT NOT NULL CHECK (agent IN ('codex', 'claude')),
          task TEXT NOT NULL,
          entry_id TEXT NOT NULL UNIQUE,
          token TEXT NOT NULL,
          dispatcher_pid INTEGER NOT NULL CHECK (dispatcher_pid > 0),
          child_pid INTEGER CHECK (child_pid IS NULL OR child_pid > 1),
          UNIQUE (agent, task)
        ) STRICT
      `);
      chmodSync(this.databasePath, 0o600);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private write<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private rows(): AttemptRow[] {
    return this.database.prepare('SELECT * FROM attempts ORDER BY slot').all().map(row);
  }

  private reconcileRows(): AttemptRow[] {
    for (const attempt of this.rows()) {
      if (processAlive(attempt.dispatcher_pid)) continue;
      if (attempt.child_pid === null || processAlive(attempt.child_pid)) continue;
      this.database.prepare('DELETE FROM attempts WHERE attempt_id = ?').run(attempt.attempt_id);
    }
    return this.rows();
  }

  reconcile(): void {
    this.write(() => { this.reconcileRows(); });
  }

  list(): DeliveryAttemptStatus[] {
    return this.write(() => this.reconcileRows().map((attempt) => ({
      entry_id: attempt.entry_id,
      dispatcher_pid: attempt.dispatcher_pid,
      child_pid: attempt.child_pid,
    })));
  }

  admit(entry: Entry, dispatcherPid: number): DeliveryAttempt | undefined {
    if (!entry.token) throw new Error('Reserved queue entry has no ownership token');
    const ownershipToken = entry.token;
    if (!Number.isSafeInteger(dispatcherPid) || dispatcherPid <= 0) throw new Error('Invalid dispatcher process ID');
    return this.write(() => {
      const attempts = this.reconcileRows();
      if (attempts.length >= deliveryLimit) return undefined;
      if (attempts.some((attempt) => attempt.entry_id === entry.id)) return undefined;
      const occupiedOwners = this.database.prepare(
        'SELECT 1 FROM attempts WHERE agent = ? AND task = ?',
      ).get(entry.agent, entry.task);
      if (occupiedOwners !== undefined) return undefined;
      const used = new Set(attempts.map((attempt) => attempt.slot));
      const slot = Array.from({ length: deliveryLimit }, (_, index) => index).find((candidate) => !used.has(candidate));
      if (slot === undefined) return undefined;
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO attempts (attempt_id, slot, agent, task, entry_id, token, dispatcher_pid, child_pid)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(id, slot, entry.agent, entry.task, entry.id, ownershipToken, dispatcherPid);
      return { id, entryId: entry.id, token: ownershipToken, dispatcherPid };
    });
  }

  beforeSpawn(attempt: DeliveryAttempt): void {
    const result = this.database.prepare(`
      UPDATE attempts SET child_pid = NULL
      WHERE attempt_id = ? AND entry_id = ? AND token = ? AND dispatcher_pid = ?
    `).run(attempt.id, attempt.entryId, attempt.token, attempt.dispatcherPid);
    if (Number(result.changes) !== 1) throw new Error('Delivery attempt is no longer registered');
  }

  spawned(attempt: DeliveryAttempt, childPid: number): void {
    if (!Number.isSafeInteger(childPid) || childPid <= 1) throw new Error('Invalid delivery child process ID');
    const result = this.database.prepare(`
      UPDATE attempts SET child_pid = ?
      WHERE attempt_id = ? AND entry_id = ? AND token = ? AND dispatcher_pid = ? AND child_pid IS NULL
    `).run(childPid, attempt.id, attempt.entryId, attempt.token, attempt.dispatcherPid);
    if (Number(result.changes) !== 1) throw new Error('Delivery attempt is no longer registered');
  }

  release(attempt: DeliveryAttempt): void {
    this.database.prepare(`
      DELETE FROM attempts
      WHERE attempt_id = ? AND entry_id = ? AND token = ? AND dispatcher_pid = ?
    `).run(attempt.id, attempt.entryId, attempt.token, attempt.dispatcherPid);
  }

  reconcileUnknown<T>(entryId: string, quiescent: boolean, authorize: () => T): T {
    return this.write(() => {
      const authorized = authorize();
      const attempts = this.reconcileRows().filter((attempt) => attempt.entry_id === entryId);
      for (const attempt of attempts) {
        if (processAlive(attempt.dispatcher_pid)) {
          throw new Error('Delivery is still owned by a live dispatcher');
        }
        if (attempt.child_pid !== null) {
          if (processAlive(attempt.child_pid)) throw new Error('Delivery child process is still running');
          continue;
        }
        if (!quiescent) throw new Error('Unknown delivery requires --quiescent after confirming its child has stopped');
        this.database.prepare('DELETE FROM attempts WHERE attempt_id = ? AND child_pid IS NULL').run(attempt.attempt_id);
      }
      return authorized;
    });
  }
}

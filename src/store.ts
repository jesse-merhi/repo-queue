import {
  chmodSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
  agents,
  deliveryStatuses,
  providers,
  queueStates,
  type AddEntryInput,
  type Entry,
  type Provider,
} from "./types.ts";

const SCHEMA_VERSION = 2;
const MAX_URL_LENGTH = 2_048;
const MAX_SEGMENT_LENGTH = 255;
const MAX_TASK_LENGTH = 64;
const MAX_PATH_LENGTH = 4_096;
const MAX_TOKEN_LENGTH = 1_024;
const MAX_MESSAGE_LENGTH = 4_096;
const MAX_TIMESTAMP_LENGTH = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const PULL_REQUEST_URL = /^https:\/\/(github\.com|bitbucket\.org)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|pull-requests)\/([0-9]+)\/?$/i;

export class ConflictError extends Error {}
export class InvalidUrlError extends Error {}
export class EntryNotFoundError extends Error {}
export class OwnershipError extends Error {}
export class StateError extends Error {}
export class SchemaVersionError extends Error {}
export class InvalidStoredEntryError extends Error {}

interface PullRequest {
  provider: Provider;
  repo: string;
  prNumber: number;
  canonicalUrl: string;
}

function now(): string {
  return new Date().toISOString().replace("Z", "000+00:00");
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidStoredEntryError("stored queue entry is not an object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item]),
  );
}

function storedString(
  row: Record<string, unknown>,
  key: string,
  maximum: number,
  allowEmpty = false,
): string {
  const value = row[key];
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new InvalidStoredEntryError(`stored queue entry has invalid ${key}`);
  }
  return value;
}

function storedInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidStoredEntryError(`stored queue entry has invalid ${key}`);
  }
  return value;
}

function member<T extends string>(
  value: string,
  values: readonly T[],
): value is T {
  return values.some((candidate) => candidate === value);
}

function parseStoredEntry(value: unknown): Entry {
  const row = record(value);
  const expectedKeys = [
    "sequence",
    "id",
    "url",
    "provider",
    "repo",
    "pr_number",
    "agent",
    "task",
    "cwd",
    "state",
    "token",
    "block_reason",
    "delivery_status",
    "delivery_error",
    "created_at",
    "updated_at",
  ] as const;
  if (expectedKeys.some((key) => !hasOwn(row, key))) {
    throw new InvalidStoredEntryError("stored queue entry is missing columns");
  }

  const id = storedString(row, "id", MAX_TASK_LENGTH);
  const url = storedString(row, "url", MAX_URL_LENGTH);
  const provider = storedString(row, "provider", 16);
  const repo = storedString(row, "repo", MAX_URL_LENGTH);
  const agent = storedString(row, "agent", 16);
  const task = storedString(row, "task", MAX_TASK_LENGTH);
  const cwd = storedString(row, "cwd", MAX_PATH_LENGTH);
  const ownerConfigValue = row.owner_config_root;
  const ownerConfigExplicitValue = row.owner_config_explicit;
  const checkpointValue = row.checkpoint_path;
  const state = storedString(row, "state", 16);
  const storedToken = row.token;
  const blockReason = storedString(row, "block_reason", MAX_MESSAGE_LENGTH, true);
  const deliveryStatus = storedString(row, "delivery_status", 16);
  const deliveryError = storedString(row, "delivery_error", MAX_MESSAGE_LENGTH, true);
  const createdAt = storedString(row, "created_at", MAX_TIMESTAMP_LENGTH);
  const updatedAt = storedString(row, "updated_at", MAX_TIMESTAMP_LENGTH);
  const sequence = storedInteger(row, "sequence");
  const prNumber = storedInteger(row, "pr_number");

  if (!UUID.test(id) || !UUID.test(task)) {
    throw new InvalidStoredEntryError("stored queue entry has an invalid UUID");
  }
  if (!member(provider, providers)) {
    throw new InvalidStoredEntryError("stored queue entry has an invalid provider");
  }
  if (!member(agent, agents)) {
    throw new InvalidStoredEntryError("stored queue entry has an invalid agent");
  }
  if (!member(state, queueStates)) {
    throw new InvalidStoredEntryError("stored queue entry has an invalid state");
  }
  if (!member(deliveryStatus, deliveryStatuses)) {
    throw new InvalidStoredEntryError(
      "stored queue entry has an invalid delivery_status",
    );
  }
  if (
    storedToken !== null &&
    (typeof storedToken !== "string" ||
      storedToken.length === 0 ||
      storedToken.length > MAX_TOKEN_LENGTH)
  ) {
    throw new InvalidStoredEntryError("stored queue entry has an invalid token");
  }
  if (
    typeof ownerConfigValue === "string" &&
    ownerConfigExplicitValue !== 0 &&
    ownerConfigExplicitValue !== 1 &&
    ownerConfigExplicitValue !== null &&
    ownerConfigExplicitValue !== undefined
  ) {
    throw new InvalidStoredEntryError(
      "stored queue entry has invalid owner configuration environment metadata",
    );
  }
  if (
    (ownerConfigValue === null || ownerConfigValue === undefined) &&
    ownerConfigExplicitValue !== null &&
    ownerConfigExplicitValue !== undefined
  ) {
    throw new InvalidStoredEntryError(
      "stored queue entry has owner configuration environment metadata without a root",
    );
  }
  if (!isAbsolute(cwd)) {
    throw new InvalidStoredEntryError("stored queue entry has a non-absolute cwd");
  }
  if (
    ownerConfigValue !== undefined &&
    ownerConfigValue !== null &&
    (typeof ownerConfigValue !== "string" ||
      ownerConfigValue.length === 0 ||
      ownerConfigValue.length > MAX_PATH_LENGTH ||
      !isAbsolute(ownerConfigValue))
  ) {
    throw new InvalidStoredEntryError(
      "stored queue entry has an invalid owner configuration root",
    );
  }
  if (checkpointValue !== undefined && checkpointValue !== null &&
    (typeof checkpointValue !== "string" || checkpointValue.length === 0 ||
      checkpointValue.length > MAX_PATH_LENGTH || !isAbsolute(checkpointValue))) {
    throw new InvalidStoredEntryError("stored queue entry has an invalid checkpoint path");
  }
  let parsed: PullRequest;
  try {
    parsed = pullRequest(url);
  } catch (error: unknown) {
    throw new InvalidStoredEntryError(
      "stored queue entry has an invalid PR URL",
      { cause: error },
    );
  }
  if (
    parsed.provider !== provider ||
    parsed.repo !== repo ||
    parsed.prNumber !== prNumber ||
    parsed.canonicalUrl !== url
  ) {
    throw new InvalidStoredEntryError("stored queue entry has inconsistent PR fields");
  }
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new InvalidStoredEntryError("stored queue entry has an invalid timestamp");
  }

  return {
    sequence,
    id,
    url,
    provider,
    repo,
    pr_number: prNumber,
    agent,
    task,
    cwd,
    ...(typeof ownerConfigValue === "string"
      ? { owner_config_root: ownerConfigValue }
      : {}),
    ...(ownerConfigExplicitValue === 0 || ownerConfigExplicitValue === 1
      ? { owner_config_explicit: ownerConfigExplicitValue === 1 }
      : {}),
    ...(typeof checkpointValue === "string" ? { checkpoint_path: checkpointValue } : {}),
    state,
    token: storedToken,
    block_reason: blockReason,
    delivery_status: deliveryStatus,
    delivery_error: deliveryError,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function boundedString(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && value.length === 0)
  ) {
    const description = allowEmpty ? "a bounded string" : "a non-empty bounded string";
    throw new TypeError(`${name} must be ${description}`);
  }
  return value;
}

function configEnvironmentVariable(agent: Entry["agent"]): "CODEX_HOME" | "CLAUDE_CONFIG_DIR" {
  return agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
}

type OwnerConfigInput = Pick<
  AddEntryInput,
  "agent" | "cwd" | "owner_config_root"
>;

interface OwnerConfig {
  root: string;
  explicit?: boolean;
}

function ownerConfig(input: Readonly<OwnerConfigInput>, cwd: string): OwnerConfig {
  if (input.owner_config_root !== undefined) {
    const supplied = boundedString(
      input.owner_config_root,
      "owner configuration root",
      MAX_PATH_LENGTH,
    );
    if (!isAbsolute(supplied)) {
      throw new TypeError("owner configuration root must be absolute");
    }
    return {
      root: supplied,
      ...(input.agent === "claude" ? { explicit: true } : {}),
    };
  }
  const configured = process.env[configEnvironmentVariable(input.agent)];
  if (configured !== undefined && configured.length > 0) {
    return {
      root: resolve(
        cwd,
        boundedString(configured, "owner configuration root", MAX_PATH_LENGTH),
      ),
      ...(input.agent === "claude" ? { explicit: true } : {}),
    };
  }
  return {
    root: join(homedir(), input.agent === "codex" ? ".codex" : ".claude"),
    ...(input.agent === "claude" ? { explicit: false } : {}),
  };
}

function pullRequest(input: unknown): PullRequest {
  if (typeof input !== "string" || input.length === 0) {
    throw new InvalidUrlError("pull request URL must be a non-empty string");
  }
  if (input.length > MAX_URL_LENGTH) {
    throw new InvalidUrlError("pull request URL is too long");
  }
  const value = input;
  if (/\s/.test(value)) {
    throw new InvalidUrlError("pull request URL must not contain whitespace");
  }
  const match = PULL_REQUEST_URL.exec(value);
  if (match === null) {
    throw new InvalidUrlError("unsupported pull request URL");
  }
  const hostMatch = match[1];
  const ownerMatch = match[2];
  const repositoryMatch = match[3];
  const marker = match[4];
  const numberText = match[5];
  if (
    hostMatch === undefined ||
    ownerMatch === undefined ||
    repositoryMatch === undefined ||
    marker === undefined ||
    numberText === undefined
  ) {
    throw new InvalidUrlError("malformed pull request URL");
  }
  if (
    ownerMatch.length > MAX_SEGMENT_LENGTH ||
    repositoryMatch.length > MAX_SEGMENT_LENGTH ||
    !SEGMENT.test(ownerMatch) ||
    !SEGMENT.test(repositoryMatch) ||
    ownerMatch === "." ||
    ownerMatch === ".." ||
    repositoryMatch === "." ||
    repositoryMatch === ".."
  ) {
    throw new InvalidUrlError(
      "repository owner and name contain invalid characters",
    );
  }
  const host = hostMatch.toLowerCase();
  const expectedMarker = host === "github.com" ? "pull" : "pull-requests";
  if (marker !== expectedMarker) {
    throw new InvalidUrlError("unsupported pull request URL path");
  }
  const prNumber = Number(numberText);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new InvalidUrlError("pull request number must be a positive safe integer");
  }
  const owner = ownerMatch.toLowerCase();
  const repository = repositoryMatch.toLowerCase();
  const provider: Provider = host === "github.com" ? "github" : "bitbucket";
  const repo = `${host}/${owner}/${repository}`;
  return {
    provider,
    repo,
    prNumber,
    canonicalUrl: `https://${repo}/${expectedMarker}/${prNumber}`,
  };
}

function equalToken(stored: string | null, supplied: unknown): boolean {
  if (
    stored === null ||
    typeof supplied !== "string" ||
    supplied.length === 0 ||
    supplied.length > MAX_TOKEN_LENGTH
  ) {
    return false;
  }
  const storedDigest = createHash("sha256").update(stored).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(storedDigest, suppliedDigest);
}

function changes(result: number | bigint): number {
  return typeof result === "bigint" ? Number(result) : result;
}

export class Store {
  readonly stateDir: string;
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(stateDir: string) {
    const requested = boundedString(stateDir, "state directory", MAX_PATH_LENGTH);
    this.stateDir = resolve(requested);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (!statSync(this.stateDir).isDirectory()) {
      throw new Error(`state path is not a directory: ${this.stateDir}`);
    }
    chmodSync(this.stateDir, 0o700);
    this.databasePath = join(this.stateDir, "queue.sqlite3");
    this.database = new DatabaseSync(this.databasePath, { timeout: 30_000 });
    try {
      this.database.exec("PRAGMA busy_timeout = 30000");
      this.initialize();
      chmodSync(this.databasePath, 0o600);
    } catch (error: unknown) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }

  add(input: Readonly<AddEntryInput>): Entry {
    const parsed = pullRequest(input.url);
    if (!member(input.agent, agents)) {
      throw new TypeError("agent must be codex or claude");
    }
    const task = boundedString(input.task, "task", MAX_TASK_LENGTH);
    if (!UUID.test(task)) {
      throw new TypeError("task must be a UUID");
    }
    const cwd = boundedString(input.cwd, "cwd", MAX_PATH_LENGTH);
    if (!isAbsolute(cwd)) {
      throw new TypeError("cwd must be absolute");
    }
    let cwdStatus;
    try {
      cwdStatus = statSync(cwd);
    } catch {
      throw new TypeError(`cwd must exist: ${cwd}`);
    }
    if (!cwdStatus.isDirectory()) {
      throw new TypeError("cwd must be a directory");
    }
    const config = ownerConfig(input, realpathSync(cwd));
    let checkpointPath: string | undefined;
    if (input.checkpoint_path !== undefined) {
      const path = boundedString(input.checkpoint_path, "checkpoint path", MAX_PATH_LENGTH);
      if (!isAbsolute(path)) throw new TypeError("checkpoint path must be absolute");
      checkpointPath = realpathSync(path);
      if (checkpointPath.length > MAX_PATH_LENGTH || !statSync(checkpointPath).isFile()) {
        throw new TypeError("checkpoint must be a regular file with a bounded absolute path");
      }
    }

    return this.write(() => {
      const existing = this.database
        .prepare(`
          SELECT entries.*, owner_configs.config_root AS owner_config_root,
          owner_configs.env_explicit AS owner_config_explicit,
          entry_checkpoints.path AS checkpoint_path
          FROM entries
          LEFT JOIN owner_configs ON owner_configs.entry_id = entries.id
          LEFT JOIN entry_checkpoints ON entry_checkpoints.entry_id = entries.id
          WHERE entries.repo = ? AND entries.pr_number = ?
        `)
        .get(parsed.repo, parsed.prNumber);
      if (existing !== undefined) {
        const entry = parseStoredEntry(existing);
        if (
          entry.agent === input.agent &&
          entry.task === task &&
          entry.cwd === cwd &&
          (entry.owner_config_root === undefined || entry.owner_config_root === config.root) &&
          (entry.owner_config_explicit === undefined ||
            entry.owner_config_explicit === config.explicit)
        ) {
          if (checkpointPath !== undefined && checkpointPath !== entry.checkpoint_path) {
            throw new ConflictError("pull request is already registered with a different checkpoint; update the original file");
          }
          return entry;
        }
        throw new ConflictError(
          "pull request is already registered to a different agent, task, cwd, or configuration root",
        );
      }

      const timestamp = now();
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO entries (
          id, url, provider, repo, pr_number, agent, task, cwd,
          state, token, block_reason, delivery_status, delivery_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, '', 'pending', '', ?, ?)
      `).run(
        id,
        parsed.canonicalUrl,
        parsed.provider,
        parsed.repo,
        parsed.prNumber,
        input.agent,
        task,
        cwd,
        token(),
        timestamp,
        timestamp,
      );
      this.database.prepare(`
        INSERT INTO owner_configs (entry_id, config_root, env_explicit) VALUES (?, ?, ?)
      `).run(
        id,
        config.root,
        config.explicit === undefined ? null : config.explicit ? 1 : 0,
      );
      if (checkpointPath !== undefined) {
        this.database.prepare("INSERT INTO entry_checkpoints (entry_id, path) VALUES (?, ?)").run(id, checkpointPath);
      }
      return this.updated(id);
    });
  }

  list(): Entry[] {
    return this.database
      .prepare(`
        SELECT entries.*, owner_configs.config_root AS owner_config_root,
          owner_configs.env_explicit AS owner_config_explicit,
          entry_checkpoints.path AS checkpoint_path
        FROM entries
        LEFT JOIN owner_configs ON owner_configs.entry_id = entries.id
        LEFT JOIN entry_checkpoints ON entry_checkpoints.entry_id = entries.id
        ORDER BY entries.sequence
      `)
      .all()
      .map((row) => parseStoredEntry(row));
  }

  reserve(): Entry[] {
    return this.write(() => {
      const candidates = this.database.prepare(`
        SELECT candidate.id
        FROM entries AS candidate
        WHERE candidate.state = 'waiting'
          AND candidate.sequence = (
            SELECT MIN(waiter.sequence)
            FROM entries AS waiter
            WHERE waiter.repo = candidate.repo
              AND waiter.state = 'waiting'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM entries AS active
            WHERE active.repo = candidate.repo
              AND active.state IN ('reserved', 'claimed', 'blocked')
          )
        ORDER BY candidate.sequence
      `).all();
      const reserved: Entry[] = [];
      for (const candidateValue of candidates) {
        const candidate = record(candidateValue);
        const id = storedString(candidate, "id", MAX_TASK_LENGTH);
        this.database.prepare(`
          UPDATE entries
          SET state = 'reserved', token = COALESCE(token, ?), block_reason = '',
              delivery_status = 'pending', delivery_error = '', updated_at = ?
          WHERE id = ? AND state = 'waiting'
        `).run(token(), now(), id);
        reserved.push(this.updated(id));
      }
      return reserved;
    });
  }

  claim(id: string, suppliedToken: string): Entry {
    return this.write(() => {
      const entry = this.owned(id, suppliedToken);
      if (entry.state !== "reserved") {
        throw new StateError(`queue entry cannot be claimed from state ${entry.state}`);
      }
      this.database
        .prepare("UPDATE entries SET state = 'claimed', updated_at = ? WHERE id = ?")
        .run(now(), id);
      return this.updated(id);
    });
  }

  verifyClaim(
    id: string,
    suppliedToken: string,
    owner: Readonly<Pick<AddEntryInput, "agent" | "task" | "cwd" | "owner_config_root">>,
  ): Entry {
    const entry = this.owned(id, suppliedToken);
    if (entry.state !== "claimed") {
      throw new StateError(
        `queue entry claim cannot be verified from state ${entry.state}`,
      );
    }
    if (!member(owner.agent, agents)) {
      throw new TypeError("agent must be codex or claude");
    }
    const task = boundedString(owner.task, "task", MAX_TASK_LENGTH);
    if (!UUID.test(task)) {
      throw new TypeError("task must be a UUID");
    }
    const cwd = boundedString(owner.cwd, "cwd", MAX_PATH_LENGTH);
    if (!isAbsolute(cwd)) {
      throw new TypeError("cwd must be absolute");
    }
    let ownerCwd: string;
    let entryCwd: string;
    try {
      ownerCwd = realpathSync(cwd);
      entryCwd = realpathSync(entry.cwd);
    } catch {
      throw new OwnershipError("queue entry owner cwd is unavailable");
    }
    const config = ownerConfig(owner, ownerCwd);
    if (
      entry.agent !== owner.agent ||
      entry.task !== task ||
      entryCwd !== ownerCwd ||
      (entry.owner_config_root !== undefined && entry.owner_config_root !== config.root) ||
      (entry.owner_config_explicit !== undefined &&
        entry.owner_config_explicit !== config.explicit)
    ) {
      throw new OwnershipError(
        "queue entry is claimed by a different agent, task, cwd, or configuration root",
      );
    }
    return entry;
  }

  verifyOwnership(id: string, suppliedToken: string): Entry {
    return this.owned(id, suppliedToken);
  }

  done(id: string, suppliedToken: string): Entry {
    return this.write(() => {
      const entry = this.owned(id, suppliedToken);
      if (entry.state === "done") {
        return entry;
      }
      if (entry.state !== "claimed") {
        throw new StateError(`queue entry cannot be completed from state ${entry.state}`);
      }
      this.database
        .prepare("UPDATE entries SET state = 'done', updated_at = ? WHERE id = ?")
        .run(now(), id);
      return this.updated(id);
    });
  }

  block(id: string, suppliedToken: string, reason: string): Entry {
    const validatedReason = boundedString(reason, "block reason", MAX_MESSAGE_LENGTH);
    if (validatedReason.trim().length === 0) {
      throw new TypeError("block reason must be non-empty");
    }
    return this.write(() => {
      const entry = this.owned(id, suppliedToken);
      if (!["reserved", "claimed", "blocked"].includes(entry.state)) {
        throw new StateError(`queue entry cannot be blocked from state ${entry.state}`);
      }
      this.database.prepare(`
        UPDATE entries SET state = 'blocked', block_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(validatedReason, now(), id);
      return this.updated(id);
    });
  }

  retry(id: string, suppliedToken: string): Entry {
    return this.write(() => {
      const entry = this.owned(id, suppliedToken);
      if (entry.state !== "reserved") {
        throw new StateError(
          `queue entry cannot be retried from state ${entry.state}; ` +
            "use recover after quiescing a claimed or blocked owner",
        );
      }
      this.database.prepare(`
        UPDATE entries
        SET token = ?, delivery_status = 'pending', delivery_error = '', updated_at = ?
        WHERE id = ?
      `).run(token(), now(), id);
      return this.updated(id);
    });
  }

  recover(id: string, suppliedToken: string): Entry {
    return this.write(() => {
      const entry = this.owned(id, suppliedToken);
      if (entry.state !== "claimed" && entry.state !== "blocked") {
        throw new StateError(`queue entry cannot be recovered from state ${entry.state}`);
      }
      this.database.prepare(`
        UPDATE entries
        SET state = 'reserved', token = ?, block_reason = '',
            delivery_status = 'pending', delivery_error = '', updated_at = ?
        WHERE id = ?
      `).run(token(), now(), id);
      return this.updated(id);
    });
  }

  pendingNotifications(): Entry[] {
    return this.database.prepare(`
      SELECT entries.*, owner_configs.config_root AS owner_config_root,
        owner_configs.env_explicit AS owner_config_explicit,
          entry_checkpoints.path AS checkpoint_path
      FROM entries
      LEFT JOIN owner_configs ON owner_configs.entry_id = entries.id
      LEFT JOIN entry_checkpoints ON entry_checkpoints.entry_id = entries.id
      WHERE entries.state = 'reserved' AND entries.delivery_status = 'pending'
      ORDER BY entries.sequence
    `).all().map((row) => parseStoredEntry(row));
  }

  markUncertain(): number {
    return this.write(() => {
      const result = this.database.prepare(`
        UPDATE entries SET delivery_status = 'uncertain', updated_at = ?
        WHERE delivery_status = 'sending'
      `).run(now());
      return changes(result.changes);
    });
  }

  beginDelivery(id: string, suppliedToken: string): boolean {
    return this.write(() => {
      const entry = this.callbackEntry(id, suppliedToken);
      if (
        entry === undefined ||
        entry.state !== "reserved" ||
        entry.delivery_status !== "pending"
      ) {
        return false;
      }
      const result = this.database.prepare(`
        UPDATE entries
        SET delivery_status = 'sending', delivery_error = '', updated_at = ?
        WHERE id = ? AND state = 'reserved' AND delivery_status = 'pending'
      `).run(now(), id);
      return changes(result.changes) === 1;
    });
  }

  delivery(
    id: string,
    suppliedToken: string,
    success: boolean,
    error = "",
  ): boolean {
    const deliveryError = boundedString(error, "delivery error", MAX_MESSAGE_LENGTH, true);
    return this.write(() => {
      const entry = this.callbackEntry(id, suppliedToken);
      if (entry === undefined) {
        return false;
      }
      if (entry.state === "waiting") {
        throw new StateError("a waiting entry has no notification to record");
      }
      this.database.prepare(`
        UPDATE entries
        SET delivery_status = ?, delivery_error = ?, updated_at = ?
        WHERE id = ?
      `).run(success ? "sent" : "failed", success ? "" : deliveryError, now(), id);
      return true;
    });
  }

  private initialize(): void {
    this.write(() => {
      const versionRow = this.database.prepare("PRAGMA user_version").get();
      const versionRecord = record(versionRow);
      const versionValue = versionRecord.user_version;
      if (
        typeof versionValue !== "number" ||
        !Number.isSafeInteger(versionValue) ||
        versionValue < 0
      ) {
        throw new SchemaVersionError("database has an invalid schema version");
      }
      if (versionValue > SCHEMA_VERSION) {
        throw new SchemaVersionError(
          `database schema version ${versionValue} is newer than supported version ${SCHEMA_VERSION}`,
        );
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          url TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          repo TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          agent TEXT NOT NULL,
          task TEXT NOT NULL,
          cwd TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('waiting', 'reserved', 'claimed', 'blocked', 'done')
          ),
          token TEXT,
          block_reason TEXT NOT NULL DEFAULT '',
          delivery_status TEXT NOT NULL CHECK (
            delivery_status IN ('pending', 'sending', 'sent', 'failed', 'uncertain')
          ),
          delivery_error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (repo, pr_number)
        );
        CREATE INDEX IF NOT EXISTS entries_repo_state_sequence
          ON entries (repo, state, sequence);
        CREATE TABLE IF NOT EXISTS entry_checkpoints (
          entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
          path TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owner_configs (
          entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
          config_root TEXT NOT NULL,
          env_explicit INTEGER CHECK (
            env_explicit IN (0, 1) OR env_explicit IS NULL
          )
        );
      `);
      if (versionValue === 1) {
        this.database.exec(`
          ALTER TABLE owner_configs ADD COLUMN env_explicit INTEGER CHECK (
            env_explicit IN (0, 1) OR env_explicit IS NULL
          )
        `);
      }
      if (versionValue < SCHEMA_VERSION) {
        this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
    });
  }

  private write<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private find(id: string): Entry | undefined {
    const validatedId = boundedString(id, "entry id", MAX_TASK_LENGTH);
    const row = this.database
      .prepare(`
        SELECT entries.*, owner_configs.config_root AS owner_config_root,
          owner_configs.env_explicit AS owner_config_explicit,
          entry_checkpoints.path AS checkpoint_path
        FROM entries
        LEFT JOIN owner_configs ON owner_configs.entry_id = entries.id
        LEFT JOIN entry_checkpoints ON entry_checkpoints.entry_id = entries.id
        WHERE entries.id = ?
      `)
      .get(validatedId);
    return row === undefined ? undefined : parseStoredEntry(row);
  }

  private updated(id: string): Entry {
    const entry = this.find(id);
    if (entry === undefined) {
      throw new EntryNotFoundError(`queue entry not found: ${id}`);
    }
    return entry;
  }

  private owned(id: string, suppliedToken: string): Entry {
    const entry = this.find(id);
    if (entry === undefined) {
      throw new EntryNotFoundError(`queue entry not found: ${id}`);
    }
    if (!equalToken(entry.token, suppliedToken)) {
      throw new OwnershipError("stale or invalid ownership token");
    }
    return entry;
  }

  private callbackEntry(id: string, suppliedToken: string): Entry | undefined {
    const entry = this.find(id);
    if (entry === undefined || !equalToken(entry.token, suppliedToken)) {
      return undefined;
    }
    return entry;
  }
}

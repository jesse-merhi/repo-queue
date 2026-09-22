import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  ConflictError,
  InvalidStoredEntryError,
  InvalidUrlError,
  OwnershipError,
  SchemaVersionError,
  StateError,
  Store,
} from "../src/store.ts";
import type { Agent, Entry } from "../src/types.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "repo-queue-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

interface Fixture {
  root: string;
  stateDir: string;
  cwd: string;
  store: Store;
}

function fixture(): Fixture {
  const root = temporaryDirectory();
  const stateDir = join(root, "state");
  const cwd = join(root, "worktree");
  mkdirSync(cwd);
  const store = new Store(stateDir);
  return { root, stateDir, cwd, store };
}

function add(
  item: Fixture,
  url: string,
  options: { agent?: Agent; task?: string; cwd?: string } = {},
): Entry {
  return item.store.add({
    url,
    agent: options.agent ?? "codex",
    task: options.task ?? randomUUID(),
    cwd: options.cwd ?? item.cwd,
  });
}

function requireToken(entry: Entry): string {
  if (entry.token === null) {
    throw new Error("expected the queue entry to have an ownership token");
  }
  return entry.token;
}

function firstEntry(entries: readonly Entry[]): Entry {
  const entry = entries[0];
  if (entry === undefined) {
    throw new Error("expected a queue entry");
  }
  return entry;
}

interface WorkerResult {
  ok: true;
  ids: string[];
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  return value.ok === true &&
    "ids" in value &&
    Array.isArray(value.ids) &&
    value.ids.every((id) => typeof id === "string");
}

async function reserveInWorker(stateDir: string, gate: SharedArrayBuffer): Promise<string[]> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/store.ts")).href;
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    const { Store } = await import(workerData.moduleUrl);
    const signal = new Int32Array(workerData.gate);
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
    Atomics.wait(signal, 1, 0);
    const store = new Store(workerData.stateDir);
    try {
      parentPort.postMessage({
        ok: true,
        ids: store.reserve().map((entry) => entry.id),
      });
    } finally {
      store.close();
    }
  `;
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { gate, moduleUrl, stateDir },
    });
    worker.once("message", (value: unknown) => {
      if (isWorkerResult(value)) {
        resolveWorker(value.ids);
      } else {
        rejectWorker(new Error("reservation worker returned an invalid result"));
      }
    });
    worker.once("error", rejectWorker);
    worker.once("exit", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`reservation worker exited with code ${code}`));
      }
    });
  });
}

async function concurrentReservations(
  stateDir: string,
  workerCount: number,
): Promise<string[][]> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const signal = new Int32Array(gate);
  const reservations = Array.from(
    { length: workerCount },
    () => reserveInWorker(stateDir, gate),
  );
  while (Atomics.load(signal, 0) < workerCount) {
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
  Atomics.store(signal, 1, 1);
  Atomics.notify(signal, 1, workerCount);
  return Promise.all(reservations);
}

async function beginDeliveryInWorker(
  stateDir: string,
  id: string,
  tokenValue: string,
  gate: SharedArrayBuffer,
): Promise<boolean> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/store.ts")).href;
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    const { Store } = await import(workerData.moduleUrl);
    const signal = new Int32Array(workerData.gate);
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
    Atomics.wait(signal, 1, 0);
    const store = new Store(workerData.stateDir);
    try {
      parentPort.postMessage(store.beginDelivery(workerData.id, workerData.token));
    } finally {
      store.close();
    }
  `;
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { gate, id, moduleUrl, stateDir, token: tokenValue },
    });
    worker.once("message", (value: unknown) => {
      if (typeof value === "boolean") {
        resolveWorker(value);
      } else {
        rejectWorker(new Error("delivery worker returned an invalid result"));
      }
    });
    worker.once("error", rejectWorker);
    worker.once("exit", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`delivery worker exited with code ${code}`));
      }
    });
  });
}

async function concurrentDeliveryStarts(
  stateDir: string,
  entry: Entry,
  workerCount: number,
): Promise<boolean[]> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const signal = new Int32Array(gate);
  const ownerToken = requireToken(entry);
  const starts = Array.from(
    { length: workerCount },
    () => beginDeliveryInWorker(stateDir, entry.id, ownerToken, gate),
  );
  while (Atomics.load(signal, 0) < workerCount) {
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
  Atomics.store(signal, 1, 1);
  Atomics.notify(signal, 1, workerCount);
  return Promise.all(starts);
}

describe("Store", () => {
  test("normalizes supported URLs and idempotently returns the same owner entry", () => {
    const item = fixture();
    const task = randomUUID();
    const github = add(item, "https://github.com/OpenAI/Repo/pull/0007/", { task });
    const duplicate = add(item, "https://github.com/openai/repo/pull/7", { task });
    const bitbucket = add(
      item,
      "https://bitbucket.org/Work_Space/Repo.Name/pull-requests/12",
    );

    assert.deepEqual(duplicate, github);
    assert.equal(github.url, "https://github.com/openai/repo/pull/7");
    assert.equal(github.repo, "github.com/openai/repo");
    assert.equal(github.pr_number, 7);
    assert.ok(requireToken(github).length > 20);
    assert.equal(
      bitbucket.url,
      "https://bitbucket.org/work_space/repo.name/pull-requests/12",
    );
    assert.deepEqual([github.sequence, bitbucket.sequence], [1, 2]);
    item.store.close();
  });

  test("captures each owner's resolved configuration root and refuses to retarget it", () => {
    const item = fixture();
    const previousCodexHome = process.env.CODEX_HOME;
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    const task = randomUUID();
    try {
      process.env.CODEX_HOME = "codex config with spaces";
      delete process.env.CLAUDE_CONFIG_DIR;
      const codex = add(item, "https://github.com/acme/codex/pull/1", { task });
      const claude = add(item, "https://github.com/acme/claude/pull/2", {
        agent: "claude",
      });
      process.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
      const explicitClaude = add(
        item,
        "https://github.com/acme/claude-explicit/pull/3",
        { agent: "claude" },
      );
      delete process.env.CODEX_HOME;
      const defaultCodex = add(item, "https://github.com/acme/codex-default/pull/4");

      assert.equal(
        codex.owner_config_root,
        join(realpathSync(item.cwd), "codex config with spaces"),
      );
      assert.equal(claude.owner_config_root, join(homedir(), ".claude"));
      assert.equal(claude.owner_config_explicit, false);
      assert.equal(explicitClaude.owner_config_root, join(homedir(), ".claude"));
      assert.equal(explicitClaude.owner_config_explicit, true);
      assert.equal(defaultCodex.owner_config_root, join(homedir(), ".codex"));
      assert.equal(defaultCodex.owner_config_explicit, undefined);
      process.env.CODEX_HOME = "codex config with spaces";
      assert.equal(
        add(item, "https://github.com/acme/codex/pull/1", { task }).id,
        codex.id,
      );

      process.env.CODEX_HOME = join(item.root, "different-codex-home");
      assert.throws(
        () => add(item, "https://github.com/acme/codex/pull/1", { task }),
        ConflictError,
      );
      assert.equal(
        item.store.list().find((entry) => entry.id === codex.id)?.owner_config_root,
        join(realpathSync(item.cwd), "codex config with spaces"),
      );

      const database = new DatabaseSync(item.store.databasePath, { readOnly: true });
      const columns = database.prepare("PRAGMA table_info(owner_configs)").all()
        .map((value) => {
          assert.ok(typeof value.name === "string");
          return value.name;
        });
      assert.deepEqual(columns, ["entry_id", "config_root", "env_explicit"]);
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 3);
      database.close();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
      item.store.close();
    }
  });

  test("Codex ownership remains stable when delivery makes the default root explicit", () => {
    const item = fixture();
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      delete process.env.CODEX_HOME;
      const added = add(item, "https://github.com/acme/codex-owner/pull/1");
      assert.equal(added.owner_config_root, join(homedir(), ".codex"));
      assert.equal(added.owner_config_explicit, undefined);
      const reserved = firstEntry(item.store.reserve());
      const claimed = item.store.claim(reserved.id, requireToken(reserved));

      process.env.CODEX_HOME = join(homedir(), ".codex");
      assert.equal(
        item.store.verifyClaim(claimed.id, requireToken(claimed), {
          agent: "codex",
          task: claimed.task,
          cwd: claimed.cwd,
        }).id,
        claimed.id,
      );
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      item.store.close();
    }
  });

  test("version-1 migration preserves ambiguous default Claude owners", () => {
    const item = fixture();
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      const entry = add(item, "https://github.com/acme/legacy-owner/pull/1", {
        agent: "claude",
      });
      item.store.close();
      const legacy = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
      legacy.exec(`
        ALTER TABLE owner_configs DROP COLUMN env_explicit;
        PRAGMA user_version = 1;
      `);
      legacy.close();

      const migrated = new Store(item.stateDir);
      const restored = migrated.list().find((candidate) => candidate.id === entry.id);
      assert.equal(restored?.owner_config_root, join(homedir(), ".claude"));
      assert.equal(restored?.owner_config_explicit, undefined);
      const database = new DatabaseSync(migrated.databasePath, { readOnly: true });
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 3);
      assert.equal(
        database.prepare("SELECT env_explicit FROM owner_configs WHERE entry_id = ?")
          .get(entry.id)?.env_explicit,
        null,
      );
      database.close();
      migrated.close();
    } finally {
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
      item.store.close();
    }
  });

  test("version-1 migration preserves an explicitly configured sent reservation", () => {
    const item = fixture();
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
      const entry = add(item, "https://github.com/acme/sent-legacy-owner/pull/1", {
        agent: "claude",
      });
      const reserved = firstEntry(item.store.reserve());
      assert.equal(item.store.beginDelivery(reserved.id, requireToken(reserved)), true);
      assert.equal(item.store.delivery(reserved.id, requireToken(reserved), true), true);
      item.store.close();

      const legacy = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
      legacy.exec(`
        ALTER TABLE owner_configs DROP COLUMN env_explicit;
        PRAGMA user_version = 1;
      `);
      legacy.close();

      const migrated = new Store(item.stateDir);
      const restored = migrated.list().find((candidate) => candidate.id === entry.id);
      assert.ok(restored !== undefined);
      assert.equal(restored?.state, "reserved");
      assert.equal(restored?.delivery_status, "sent");
      assert.equal(restored?.owner_config_explicit, undefined);
      assert.equal(
        migrated.add({
          url: "https://github.com/acme/sent-legacy-owner/pull/1",
          agent: "claude",
          task: entry.task,
          cwd: item.cwd,
        }).id,
        entry.id,
      );
      const claimed = migrated.claim(restored.id, requireToken(restored));
      assert.equal(
        migrated.verifyClaim(claimed.id, requireToken(claimed), {
          agent: "claude",
          task: claimed.task,
          cwd: claimed.cwd,
        }).id,
        claimed.id,
      );
      migrated.close();
    } finally {
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
      item.store.close();
    }
  });

  test("version-1 migration preserves a claimed Claude owner's environment mode", () => {
    const item = fixture();
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
      const entry = add(item, "https://github.com/acme/claimed-legacy-owner/pull/1", {
        agent: "claude",
      });
      const reserved = firstEntry(item.store.reserve());
      const claimed = item.store.claim(reserved.id, requireToken(reserved));
      item.store.close();

      const legacy = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
      legacy.exec(`
        ALTER TABLE owner_configs DROP COLUMN env_explicit;
        PRAGMA user_version = 1;
      `);
      legacy.close();

      const migrated = new Store(item.stateDir);
      const restored = migrated.list().find((candidate) => candidate.id === entry.id);
      assert.equal(restored?.owner_config_explicit, undefined);
      assert.equal(
        migrated.verifyClaim(claimed.id, requireToken(claimed), {
          agent: "claude",
          task: claimed.task,
          cwd: claimed.cwd,
        }).id,
        claimed.id,
      );
      migrated.close();
    } finally {
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
      item.store.close();
    }
  });

  test("version-2 migration preserves explicit Claude roots and completed history", () => {
    const item = fixture();
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
      const explicitDefault = add(
        item,
        "https://github.com/acme/explicit-default/pull/1",
        { agent: "claude" },
      );
      process.env.CLAUDE_CONFIG_DIR = join(item.root, "custom-claude");
      const explicitCustom = add(
        item,
        "https://github.com/acme/explicit-custom/pull/1",
        { agent: "claude" },
      );
      delete process.env.CLAUDE_CONFIG_DIR;
      const completed = add(
        item,
        "https://github.com/acme/completed-default/pull/1",
        { agent: "claude" },
      );
      const reserved = item.store.reserve().find((entry) => entry.id === completed.id);
      assert.ok(reserved !== undefined);
      const claimed = item.store.claim(reserved.id, requireToken(reserved));
      item.store.done(claimed.id, requireToken(claimed));
      item.store.close();

      const legacy = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
      legacy.prepare(`
        UPDATE owner_configs SET env_explicit = NULL WHERE entry_id = ?
      `).run(completed.id);
      legacy.exec("PRAGMA user_version = 2");
      legacy.close();

      const migrated = new Store(item.stateDir);
      const entries = migrated.list();
      assert.equal(
        entries.find((entry) => entry.id === explicitDefault.id)?.owner_config_explicit,
        true,
      );
      assert.equal(
        entries.find((entry) => entry.id === explicitCustom.id)?.owner_config_explicit,
        true,
      );
      assert.equal(
        entries.find((entry) => entry.id === completed.id)?.owner_config_explicit,
        undefined,
      );
      migrated.close();
    } finally {
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
      if (item.store) item.store.close();
    }
  });

  test("rolls back a new entry when its owner configuration cannot be stored", () => {
    const item = fixture();
    const database = new DatabaseSync(item.store.databasePath);
    database.exec(`
      CREATE TRIGGER reject_owner_config
      BEFORE INSERT ON owner_configs
      BEGIN
        SELECT RAISE(ABORT, 'fixture owner configuration failure');
      END;
    `);
    database.close();

    assert.throws(
      () => add(item, "https://github.com/acme/widget/pull/1"),
      /fixture owner configuration failure/,
    );
    assert.deepEqual(item.store.list(), []);
    item.store.close();
  });

  test("rejects a duplicate registration owned by different work", () => {
    const item = fixture();
    const original = add(item, "https://github.com/acme/widget/pull/4");

    assert.throws(
      () => add(item, "https://github.com/ACME/WIDGET/pull/04/"),
      ConflictError,
    );
    assert.deepEqual(item.store.list(), [original]);
    item.store.close();
  });

  test("rejects non-exact PR URLs before URL normalization", () => {
    const item = fixture();
    const invalidUrls = [
      "",
      " http://github.com/acme/widget/pull/1",
      "https://github.com/acme/widget/pull/1 ",
      "https://evil.example/acme/widget/pull/1",
      "https://user@github.com/acme/widget/pull/1",
      "https://github.com:443/acme/widget/pull/1",
      "https://github.com/acme/../pull/1",
      "https://github.com/acme/./pull/1",
      "https://github.com/acme/%2e%2e/pull/1",
      "https://github.com/acme/widget/issues/1",
      "https://github.com/acme/widget/pull/0",
      "https://github.com/acme/widget/pull/9007199254740992",
      "https://github.com/acme/widget/pull/1?diff=split",
      "https://github.com/acme/widget/pull/1#discussion",
      "https://github.com/acme/widget/pull/1/files",
      "https://bitbucket.org/acme/widget/pull/1",
      "https://github.com/acme\\widget/pull/1",
      "https://github.com//acme/widget/pull/1",
      "https://github.com/acme/widget/PULL/1",
    ];

    for (const url of invalidUrls) {
      assert.throws(() => add(item, url), InvalidUrlError, url);
    }
    assert.deepEqual(item.store.list(), []);
    item.store.close();
  });

  test("validates owner metadata and does not insert rejected work", () => {
    const item = fixture();
    assert.throws(
      () => item.store.add({
        url: "https://github.com/acme/widget/pull/1",
        agent: "codex",
        task: "not-a-uuid",
        cwd: item.cwd,
      }),
      /task must be a UUID/,
    );
    assert.throws(
      () => item.store.add({
        url: "https://github.com/acme/widget/pull/1",
        agent: "codex",
        task: randomUUID(),
        cwd: join(item.root, "missing"),
      }),
      /cwd must exist/,
    );
    assert.throws(
      () => item.store.add({
        url: "https://github.com/acme/widget/pull/1",
        agent: "codex",
        task: randomUUID(),
        cwd: item.cwd,
        owner_config_root: "relative-config",
      }),
      /owner configuration root must be absolute/,
    );
    assert.deepEqual(item.store.list(), []);
    item.store.close();
  });

  test("reserves each idle repository's FIFO head", () => {
    const item = fixture();
    const firstA = add(item, "https://github.com/acme/a/pull/1");
    const secondA = add(item, "https://github.com/acme/a/pull/2");
    const firstB = add(item, "https://github.com/acme/b/pull/1");

    const reserved = item.store.reserve();

    assert.deepEqual(reserved.map((entry) => entry.id), [firstA.id, firstB.id]);
    assert.ok(reserved.every((entry) => entry.state === "reserved"));
    assert.deepEqual(item.store.reserve(), []);
    const firstReserved = firstEntry(reserved);
    const claimed = item.store.claim(firstReserved.id, requireToken(firstReserved));
    item.store.done(claimed.id, requireToken(claimed));
    assert.deepEqual(item.store.reserve().map((entry) => entry.id), [secondA.id]);
    item.store.close();
  });

  test("separate worker clients reserve every repository head exactly once", async () => {
    const item = fixture();
    const expected = new Set<string>();
    for (let repository = 0; repository < 6; repository += 1) {
      expected.add(add(
        item,
        `https://github.com/acme/repo-${repository}/pull/1`,
      ).id);
      add(item, `https://github.com/acme/repo-${repository}/pull/2`);
    }

    const batches = await concurrentReservations(item.stateDir, 8);
    const actual = batches.flat();
    assert.deepEqual(new Set(actual), expected);
    assert.equal(actual.length, expected.size);
    const states = item.store.list();
    assert.equal(states.filter((entry) => entry.state === "reserved").length, 6);
    assert.equal(states.filter((entry) => entry.state === "waiting").length, 6);
    item.store.close();
  });

  test("only one concurrent client begins notification delivery", async () => {
    const item = fixture();
    add(item, "https://github.com/acme/widget/pull/1");
    const reserved = firstEntry(item.store.reserve());
    const results = await concurrentDeliveryStarts(item.stateDir, reserved, 8);
    assert.equal(results.filter(Boolean).length, 1);
    item.store.close();
  });

  test("claim is single-use and done is idempotent", () => {
    const item = fixture();
    add(item, "https://github.com/acme/widget/pull/1");
    const reserved = firstEntry(item.store.reserve());
    const claimed = item.store.claim(reserved.id, requireToken(reserved));

    assert.throws(
      () => item.store.claim(reserved.id, requireToken(reserved)),
      StateError,
    );
    assert.throws(() => item.store.done(reserved.id, "stale-token"), OwnershipError);
    const completed = item.store.done(claimed.id, requireToken(claimed));
    assert.equal(completed.state, "done");
    assert.deepEqual(
      item.store.done(claimed.id, requireToken(claimed)),
      completed,
    );
    item.store.close();
  });

  test("verifies a claimed owner without repeating or changing the claim", () => {
    const item = fixture();
    const task = randomUUID();
    add(item, "https://github.com/acme/widget/pull/1", { task });
    const reserved = firstEntry(item.store.reserve());
    const ownerToken = requireToken(reserved);
    const claimed = item.store.claim(reserved.id, ownerToken);

    assert.throws(
      () => item.store.claim(claimed.id, ownerToken),
      StateError,
    );
    const beforeVerification = firstEntry(item.store.list());
    const verified = item.store.verifyClaim(claimed.id, ownerToken, {
      agent: "codex",
      task,
      cwd: item.cwd,
    });

    assert.deepEqual(verified, claimed);
    assert.deepEqual(item.store.list(), [beforeVerification]);
    item.store.close();
  });

  test("rejects claim verification for the wrong state, token, or owner tuple", () => {
    const item = fixture();
    const task = randomUUID();
    const otherCwd = join(item.root, "other-worktree");
    mkdirSync(otherCwd);
    const waiting = add(item, "https://github.com/acme/waiting/pull/1");

    assert.throws(
      () => item.store.verifyClaim(waiting.id, requireToken(waiting), {
        agent: waiting.agent,
        task: waiting.task,
        cwd: waiting.cwd,
      }),
      StateError,
    );

    add(item, "https://github.com/acme/widget/pull/1", { task });
    const reserved = item.store.reserve().find((entry) => entry.repo.endsWith("/widget"));
    if (reserved === undefined) {
      throw new Error("expected the widget entry to be reserved");
    }
    const ownerToken = requireToken(reserved);
    const claimed = item.store.claim(reserved.id, ownerToken);
    const original = item.store.list();

    assert.throws(
      () => item.store.verifyClaim(claimed.id, "stale-token", {
        agent: "codex",
        task,
        cwd: item.cwd,
      }),
      OwnershipError,
    );
    for (const owner of [
      { agent: "claude", task, cwd: item.cwd },
      { agent: "codex", task: randomUUID(), cwd: item.cwd },
      { agent: "codex", task, cwd: otherCwd },
      {
        agent: "codex",
        task,
        cwd: item.cwd,
        owner_config_root: join(item.root, "other-config"),
      },
    ] as const) {
      assert.throws(
        () => item.store.verifyClaim(claimed.id, ownerToken, owner),
        OwnershipError,
      );
    }
    assert.deepEqual(item.store.list(), original);
    item.store.close();
  });

  test("delivery failure holds the reservation until an explicit retry", () => {
    const item = fixture();
    add(item, "https://github.com/acme/widget/pull/1");
    const reserved = firstEntry(item.store.reserve());
    const oldToken = requireToken(reserved);
    assert.equal(item.store.beginDelivery(reserved.id, oldToken), true);
    assert.equal(
      item.store.delivery(reserved.id, oldToken, false, "transport failed"),
      true,
    );

    const failed = firstEntry(item.store.list());
    assert.equal(failed.state, "reserved");
    assert.equal(failed.delivery_status, "failed");
    assert.equal(failed.delivery_error, "transport failed");
    assert.deepEqual(item.store.reserve(), []);
    assert.deepEqual(item.store.pendingNotifications(), []);

    const retried = item.store.retry(reserved.id, oldToken);
    assert.notEqual(retried.token, oldToken);
    assert.equal(retried.delivery_status, "pending");
    assert.equal(item.store.beginDelivery(retried.id, oldToken), false);
    assert.equal(item.store.delivery(retried.id, oldToken, true), false);
    assert.throws(() => item.store.claim(retried.id, oldToken), OwnershipError);
    assert.deepEqual(item.store.pendingNotifications(), [retried]);
    item.store.close();
  });

  test("construction leaves in-flight sends unchanged until explicit reconciliation", () => {
    const item = fixture();
    add(item, "https://github.com/acme/widget/pull/1");
    const reserved = firstEntry(item.store.reserve());
    assert.equal(item.store.beginDelivery(reserved.id, requireToken(reserved)), true);

    const restarted = new Store(item.stateDir);
    assert.equal(firstEntry(restarted.list()).delivery_status, "sending");
    assert.equal(restarted.markUncertain(), 1);
    const persisted = firstEntry(restarted.list());
    assert.equal(persisted.state, "reserved");
    assert.equal(persisted.delivery_status, "uncertain");
    assert.deepEqual(restarted.pendingNotifications(), []);
    restarted.close();
    item.store.close();
  });

  test("block and recover retain repository ownership and fence old callbacks", () => {
    const item = fixture();
    const first = add(item, "https://github.com/acme/widget/pull/1");
    add(item, "https://github.com/acme/widget/pull/2");
    const reserved = firstEntry(item.store.reserve());
    assert.equal(reserved.id, first.id);
    const claimed = item.store.claim(reserved.id, requireToken(reserved));
    const oldToken = requireToken(claimed);
    const blocked = item.store.block(claimed.id, oldToken, "CI unavailable");

    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.block_reason, "CI unavailable");
    assert.deepEqual(item.store.reserve(), []);
    assert.throws(() => item.store.retry(blocked.id, oldToken), StateError);

    const recovered = item.store.recover(blocked.id, oldToken);
    assert.equal(recovered.state, "reserved");
    assert.equal(recovered.block_reason, "");
    assert.notEqual(recovered.token, oldToken);
    assert.equal(item.store.delivery(recovered.id, oldToken, true), false);
    assert.throws(() => item.store.claim(recovered.id, oldToken), OwnershipError);
    assert.equal(
      item.store.claim(recovered.id, requireToken(recovered)).state,
      "claimed",
    );
    item.store.close();
  });

  test("delivery results do not change claimed or done queue state", () => {
    const item = fixture();
    add(item, "https://github.com/acme/widget/pull/1");
    const reserved = firstEntry(item.store.reserve());
    const claimed = item.store.claim(reserved.id, requireToken(reserved));
    const ownerToken = requireToken(claimed);

    assert.equal(item.store.delivery(claimed.id, ownerToken, true), true);
    assert.equal(firstEntry(item.store.list()).state, "claimed");
    const done = item.store.done(claimed.id, ownerToken);
    assert.equal(item.store.delivery(done.id, ownerToken, false, "late result"), true);
    const persisted = firstEntry(item.store.list());
    assert.equal(persisted.state, "done");
    assert.equal(persisted.delivery_status, "failed");
    assert.equal(persisted.delivery_error, "late result");
    item.store.close();
  });

  test("opens a version-0 database written by the Python Store without migration", () => {
    const item = fixture();
    item.store.close();
    rmSync(item.stateDir, { force: true, recursive: true });
    mkdirSync(item.stateDir);
    const legacy = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
    legacy.exec(
      readFileSync(new URL("./fixtures/python-v0.sql", import.meta.url), "utf8"),
    );
    legacy.close();

    const migrated = new Store(item.stateDir);
    const entries = migrated.list();
    assert.equal(entries.length, 1);
    assert.equal(firstEntry(entries).url, "https://github.com/example/legacy/pull/7");
    assert.equal(
      firstEntry(entries).task,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(firstEntry(entries).token, null);
    assert.equal(firstEntry(entries).owner_config_root, undefined);
    const reserved = firstEntry(migrated.reserve());
    const ownerToken = requireToken(reserved);
    assert.ok(ownerToken.length > 20);
    assert.equal(migrated.claim(reserved.id, ownerToken).cwd, "/work/legacy");
    assert.equal(migrated.done(reserved.id, ownerToken).state, "done");
    const version = new DatabaseSync(migrated.databasePath, { readOnly: true });
    assert.equal(version.prepare("PRAGMA user_version").get()?.user_version, 3);
    version.close();
    migrated.close();
  });

  test("refuses a future schema version without changing it", () => {
    const item = fixture();
    item.store.close();
    const database = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
    database.exec("PRAGMA user_version = 99");
    database.close();

    assert.throws(() => new Store(item.stateDir), SchemaVersionError);
    const unchanged = new DatabaseSync(join(item.stateDir, "queue.sqlite3"), {
      readOnly: true,
    });
    assert.equal(unchanged.prepare("PRAGMA user_version").get()?.user_version, 99);
    unchanged.close();
  });

  test("rejects invalid persisted rows at the SQLite boundary", () => {
    const item = fixture();
    const entry = add(item, "https://github.com/acme/widget/pull/1");
    item.store.close();
    const database = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
    database.prepare("UPDATE entries SET agent = 'other' WHERE id = ?").run(entry.id);
    database.close();

    const reopened = new Store(item.stateDir);
    assert.throws(() => reopened.list(), InvalidStoredEntryError);
    reopened.close();
  });

  test("rejects invalid persisted owner configuration metadata", () => {
    const item = fixture();
    const entry = add(item, "https://github.com/acme/widget/pull/1");
    item.store.close();
    const database = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
    database.prepare("UPDATE owner_configs SET config_root = 'relative' WHERE entry_id = ?")
      .run(entry.id);
    database.close();

    const reopened = new Store(item.stateDir);
    assert.throws(() => reopened.list(), InvalidStoredEntryError);
    reopened.close();
  });

  test("uses private filesystem permissions", () => {
    const item = fixture();
    assert.equal(statSync(item.stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(item.store.databasePath).mode & 0o777, 0o600);
    item.store.close();
    item.store.close();
  });
});


test("opening a pre-checkpoint database preserves its claimed owner", () => {
  const item = fixture();
  const added = add(item, "https://github.com/acme/legacy/pull/1");
  const reserved = firstEntry(item.store.reserve());
  const claimed = item.store.claim(added.id, requireToken(reserved));
  item.store.close();
  const database = new DatabaseSync(join(item.stateDir, "queue.sqlite3"));
  database.exec("DROP TABLE entry_checkpoints");
  database.close();
  const reopened = new Store(item.stateDir);
  try {
    assert.deepEqual(reopened.verifyClaim(claimed.id, requireToken(claimed), {
      agent: claimed.agent, task: claimed.task, cwd: claimed.cwd,
    }), claimed);
    assert.equal(reopened.list()[0]?.checkpoint_path, undefined);
    assert.deepEqual(reopened.reserve(), []);
  } finally { reopened.close(); }
});

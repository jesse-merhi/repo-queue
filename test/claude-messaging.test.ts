import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import test from "node:test";

import {
  claudePidDomain,
  claudeSessionsDirectory,
  claudeSenderPrompt,
  resolveClaudeLiveAddress,
  verifyClaudePidDomain,
  verifyClaudeSenderOutput,
} from "../src/claude-messaging.ts";
import type { Entry } from "../src/types.ts";

const task = "10000000-0000-4000-8000-000000000001";

function entry(cwd: string): Entry {
  return {
    sequence: 1,
    id: "20000000-0000-4000-8000-000000000002",
    url: "https://github.com/fixture/repository/pull/1",
    provider: "github",
    repo: "github.com/fixture/repository",
    pr_number: 1,
    agent: "claude",
    task,
    cwd,
    state: "reserved",
    token: "queue-token",
    block_reason: "",
    delivery_status: "sending",
    delivery_error: "",
    created_at: "2026-09-14T00:00:00.000000+00:00",
    updated_at: "2026-09-14T00:00:00.000000+00:00",
  };
}

function pidDomain(): string {
  return claudePidDomain();
}

function senderOutput(address: string, message: string): string {
  const useId = "toolu_fixture";
  return [
    { type: "system", subtype: "init", tools: ["SendMessage"], permissionMode: "bypassPermissions" },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: useId, name: "SendMessage", input: { to: address, message } }] },
    },
    {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: useId,
          content: [{ type: "text", text: JSON.stringify({ success: true, msg_id: "message-id" }) }],
        }],
      },
    },
    { type: "result", is_error: false },
  ].map((value) => JSON.stringify(value)).join("\n");
}

test("resolves relative Claude configuration from the owner directory", () => {
  const owner = mkdtempSync(join(tmpdir(), "repoq-claude-config-owner-"));
  const absoluteConfig = join(owner, "absolute-config");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = "relative-config";
    assert.equal(
      claudeSessionsDirectory(owner),
      join(owner, "relative-config", "sessions"),
    );
    process.env.CLAUDE_CONFIG_DIR = absoluteConfig;
    assert.equal(claudeSessionsDirectory(owner), join(absoluteConfig, "sessions"));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(claudeSessionsDirectory(owner), join(homedir(), ".claude", "sessions"));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(owner, { recursive: true, force: true });
  }
});

test("resolves one exact live Claude UUID and working directory to its private UDS address", async () => {
  const root = mkdtempSync(join(tmpdir(), "repoq-claude-live-"));
  const sessions = join(root, "sessions");
  const sockets = join(root, "sockets");
  mkdirSync(sessions, { mode: 0o700 });
  mkdirSync(sockets, { mode: 0o700 });
  const socket = join(sockets, "target%20.sock");
  const server = createServer((connection) => connection.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  chmodSync(socket, 0o600);
  try {
    writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId: task,
      cwd: root,
      messagingSocketPath: socket,
      peerProtocol: 1,
      procStart: "fixture-process-start",
      pidDomain: pidDomain(),
    }), { mode: 0o600 });
    const agents = JSON.stringify([{ sessionId: task, pid: process.pid, cwd: root }]);
    const address = resolveClaudeLiveAddress(entry(root), agents, sessions);
    assert.ok(address);
    assert.ok(address.startsWith("uds:"));
    // Claude's native uds parser decodes the address before connecting.
    const destination = decodeURIComponent(address.slice(4));
    assert.equal(destination, socket);
    await new Promise<void>((resolve, reject) => {
      const connection = createConnection(destination);
      connection.once("error", reject);
      connection.once("connect", () => { connection.end(); resolve(); });
    });
    assert.equal(resolveClaudeLiveAddress(entry(root), "[]", sessions), undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a stale Claude registry record before native sending", () => {
  const root = mkdtempSync(join(tmpdir(), "repoq-claude-stale-"));
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { mode: 0o700 });
  try {
    writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId: "30000000-0000-4000-8000-000000000003",
      cwd: root,
      messagingSocketPath: join(root, "missing.sock"),
      peerProtocol: 1,
      procStart: "fixture-process-start",
      pidDomain: pidDomain(),
    }), { mode: 0o600 });
    const agents = JSON.stringify([{ sessionId: task, pid: process.pid, cwd: root }]);
    assert.throws(
      () => resolveClaudeLiveAddress(entry(root), agents, sessions),
      /registry no longer matches/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matches Claude's Linux machine and PID namespace domain exactly", () => {
  const root = mkdtempSync(join(tmpdir(), "repoq-claude-linux-domain-"));
  const machineId = join(root, "machine-id");
  const pidNamespace = join(root, "pid-namespace");
  writeFileSync(machineId, "0123456789abcdef0123456789abcdef\n");
  symlinkSync("pid:[4026531836]", pidNamespace);
  const sources = { platform: "linux" as const, machineIdPath: machineId, pidNamespacePath: pidNamespace };
  try {
    const domain = "linux:0123456789abcdef0123456789abcdef:pid:[4026531836]";
    assert.equal(claudePidDomain(sources), domain);
    assert.doesNotThrow(() => verifyClaudePidDomain(domain, sources));
    assert.throws(
      () => verifyClaudePidDomain("linux:different-machine:pid:[4026531836]", sources),
      /registry no longer matches/,
    );
    assert.throws(
      () => verifyClaudePidDomain("linux:0123456789abcdef0123456789abcdef:pid:[99]", sources),
      /registry no longer matches/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifies the native sender tool boundary, exact call, and successful receipt", () => {
  const address = "uds:/tmp/fixture.sock";
  const message = "wake with $(untrusted shell text)";
  assert.deepEqual(verifyClaudeSenderOutput(senderOutput(address, message), address, message), {
    messageId: "message-id",
    permissionMode: "bypassPermissions",
  });
  assert.match(claudeSenderPrompt(address, message), /SendMessage exactly once/);
  assert.throws(
    () => verifyClaudeSenderOutput(senderOutput(address, "changed"), address, message),
    /changed the destination or wake message/,
  );
  assert.throws(
    () => verifyClaudeSenderOutput(
      senderOutput(address, message).replace('"tools":["SendMessage"]', '"tools":["SendMessage","Bash"]'),
      address,
      message,
    ),
    /required tool boundary/,
  );
});

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";

import {
  claudeSenderPrompt,
  resolveClaudeLiveAddress,
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
  return process.platform === "darwin" ? "darwin" : "linux";
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

test("resolves one exact live Claude UUID and working directory to its private UDS address", async () => {
  const root = mkdtempSync(join(tmpdir(), "repoq-claude-live-"));
  const sessions = join(root, "sessions");
  const sockets = join(root, "sockets");
  mkdirSync(sessions, { mode: 0o700 });
  mkdirSync(sockets, { mode: 0o700 });
  const socket = join(sockets, "target.sock");
  const server = createServer();
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
    assert.equal(resolveClaudeLiveAddress(entry(root), agents, sessions), `uds:${socket}`);
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

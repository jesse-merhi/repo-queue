import { spawn } from 'node:child_process';
import {
  claudeSenderPrompt,
  resolveClaudeLiveAddress,
  verifyClaudeSenderOutput,
} from './claude-messaging.ts';
import type { Entry } from './types.ts';

const maximumOutputBytes = 1024 * 1024;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function unrefHandle(handle: object): void {
  const unref = Reflect.get(handle, 'unref');
  if (typeof unref === 'function') unref.call(handle);
}

function commandError(label: string, result: CommandResult, code: number | null, signal: NodeJS.Signals | null): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  if (detail) return new Error(`${label} failed: ${detail}`);
  if (signal) return new Error(`${label} was terminated by ${signal}`);
  return new Error(`${label} exited with status ${code ?? 'unknown'}`);
}

async function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly releaseSignal?: AbortSignal;
    readonly label: string;
  },
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const release = (): void => {
      child.unref();
      unrefHandle(child.stdout);
      unrefHandle(child.stderr);
    };
    if (options.releaseSignal?.aborted) release();
    else options.releaseSignal?.addEventListener('abort', release, { once: true });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let overflow = false;

    const append = (destination: Buffer[], chunk: Buffer, currentBytes: number): number => {
      const remaining = maximumOutputBytes - currentBytes;
      if (remaining > 0) destination.push(chunk.subarray(0, remaining));
      if (chunk.byteLength > remaining) {
        overflow = true;
        child.kill('SIGKILL');
      }
      return currentBytes + chunk.byteLength;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = append(stderr, chunk, stderrBytes); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      options.releaseSignal?.removeEventListener('abort', release);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      options.releaseSignal?.removeEventListener('abort', release);
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (overflow) {
        reject(new Error(`${options.label} output exceeded ${maximumOutputBytes} bytes`));
      } else if (code !== 0) {
        reject(commandError(options.label, result, code, signal));
      } else {
        resolve(result);
      }
    });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function claudeFinalResult(value: unknown): Record<string, unknown> | undefined {
  if (record(value)) return value;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((event) => record(event) && typeof event.type === 'string')
  ) {
    return undefined;
  }
  const results = value.filter((event) => event.type === 'result');
  const final = value.at(-1);
  return results.length === 1 && results[0] === final ? final : undefined;
}

function verifyClaudeResult(output: string, expectedSession: string): void {
  const parsed: unknown = JSON.parse(output);
  const result = claudeFinalResult(parsed);
  if (result === undefined || result.session_id !== expectedSession || result.is_error !== false) {
    throw new Error('Claude did not successfully resume the requested session; inspect its history before retrying');
  }
}

function redact(error: unknown, token: string | null): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = token ? raw.split(token).join('<redacted>') : raw;
  return new Error(safe);
}

/** Deliver one wake message. CLI acceptance is distinct from the owner's durable claim. */
export async function deliver(entry: Entry, message: string, releaseSignal?: AbortSignal): Promise<void> {
  try {
    if (entry.agent === 'codex') {
      await run(
        'codex',
        ['queue', '--thread', entry.task, '--message', message],
        {
          cwd: entry.cwd,
          timeoutMs: 60_000,
          ...(releaseSignal === undefined ? {} : { releaseSignal }),
          label: 'Codex queue delivery',
        },
      );
      return;
    }

    const active = await run('claude', ['agents', '--json'], {
      timeoutMs: 30_000,
      ...(releaseSignal === undefined ? {} : { releaseSignal }),
      label: 'Claude active-session check',
    });
    const address = resolveClaudeLiveAddress(entry, active.stdout);
    if (address !== undefined) {
      const sender = await run(
        'claude',
        [
          '-p', '--safe-mode', '--tools', 'SendMessage',
          '--permission-prompts', 'none', '--no-session-persistence',
          '--max-turns', '3', '--output-format', 'stream-json', '--verbose',
          '--', claudeSenderPrompt(address, message),
        ],
        {
          cwd: entry.cwd,
          timeoutMs: 120_000,
          ...(releaseSignal === undefined ? {} : { releaseSignal }),
          label: 'Claude native sender',
        },
      );
      verifyClaudeSenderOutput(sender.stdout, address, message);
      return;
    }
    const result = await run(
      'claude',
      [
        '-p', '--resume', entry.task, '--output-format', 'json',
        '--permission-prompts', 'none', '--', message,
      ],
      {
        cwd: entry.cwd,
        ...(releaseSignal === undefined ? {} : { releaseSignal }),
        label: 'Claude resume delivery',
      },
    );
    verifyClaudeResult(result.stdout, entry.task);
  } catch (error) {
    throw redact(error, entry.token);
  }
}

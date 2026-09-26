import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { github } from './native.ts';
import { overdueCodexClaims } from './claim-watch.ts';
import { DeliveryLedger } from './delivery-ledger.ts';
import { running, serve, start, stop } from './dispatcher.ts';
import { verifyMergedGithub } from './merged-pr.ts';
import { Store, pullRequest } from './store.ts';
import type { Agent } from './types.ts';

const help = `RepoQ — local pull request turns for coding agents

Usage: repo-queue [--state DIRECTORY] COMMAND [OPTIONS]

  add URL --agent codex|claude --task UUID [--cwd DIRECTORY] [--checkpoint FILE] [--desktop]
  submit URL --agent codex|claude --task UUID --authorize-merge [--stack] [--cwd DIRECTORY]
                                 Detect native queue; authorize required validation and merge
  resume-native ID --token=TOKEN [--quiescent]
                                 Resume the original owner’s repaired native candidate
  status                         Show queue state and overdue Codex claim alerts
  start                          Start the detached dispatcher
  stop                           Stop dispatching; retain reservations
  serve                          Run dispatcher in the foreground
  claim ID --token=TOKEN          Acquire a single-use turn
  verify-claim ID --token=TOKEN --agent codex|claude --task UUID [--cwd DIRECTORY]
                                 Verify ownership after a lost-context claim
  done ID --token=TOKEN           Complete a claimed turn
  block ID --token=TOKEN --reason TEXT
  retry ID --token=TOKEN          Redeliver an unclaimed turn; replace token
  recover ID --token=TOKEN --quiescent
                                 Recover only after old work has stopped
  reconcile-delivery ID --token=TOKEN --quiescent
                                 Clear a confirmed orphaned spawn window
  complete-merged ID --token=TOKEN --quiescent --reason TEXT
                                 Complete an unclaimable, already-merged GitHub turn
  doctor [--agent codex|claude]    Check runtime and agent executable access
  --version                      Print installed version

All output is JSON except help/version. Legacy merge and CI authority remain with the agent. Native submission requires
explicit --authorize-merge authority for required validation and merge. Default state: ~/.local/state/repo-queue, overridable with
REPO_QUEUE_STATE or --state. Keep state on a local filesystem.
`;
const options = {
  state: { type: 'string' }, agent: { type: 'string' }, task: { type: 'string' },
  cwd: { type: 'string' }, token: { type: 'string' }, reason: { type: 'string' },
  quiescent: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }, checkpoint: { type: 'string' },
  desktop: { type: 'boolean' }, 'authorize-merge': { type: 'boolean' }, stack: { type: 'boolean' },
} as const;
const allowed: Record<string, readonly string[]> = {
  submit: ['agent', 'task', 'cwd', 'checkpoint', 'desktop', 'authorize-merge', 'stack'],
  'resume-native': ['token', 'quiescent'],
  add: ['agent', 'task', 'cwd', 'checkpoint', 'desktop'], status: [], start: [], stop: [], serve: [],
  claim: ['token'], done: ['token'], block: ['token', 'reason'],
  'verify-claim': ['token', 'agent', 'task', 'cwd'],
  retry: ['token'], recover: ['token', 'quiescent'],
  'reconcile-delivery': ['token', 'quiescent'], doctor: ['agent'],
  'complete-merged': ['token', 'quiescent', 'reason'],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
function agent(value: string | undefined): Agent {
  if (value !== 'codex' && value !== 'claude') throw new Error('--agent must be codex or claude');
  return value;
}
function validateCodexOwner(owner: Agent, task: string): void {
  if (owner !== 'codex') return;
  const thread = process.env.CODEX_THREAD_ID;
  const session = process.env.CODEX_SESSION_ID;
  if (thread !== undefined && session !== undefined && thread !== session) {
    throw new Error(
      'collaboration sub-agents cannot receive RepoQ wakes; register from the root Codex task',
    );
  }
  if (thread !== undefined && task !== thread) {
    throw new Error('--task must match the current Codex task');
  }
}
function statePath(value: string): string {
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value);
}
export async function main(args: string[]): Promise<void> {
  process.umask(0o077);
  let store: Store | undefined;
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
    if (values.help || args.length === 0) { process.stdout.write(help); return; }
    if (values.version) {
      const data: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      if (typeof data !== 'object' || data === null || !('version' in data) || typeof data.version !== 'string') throw new Error('Invalid package metadata');
      process.stdout.write(`RepoQ ${data.version}\n`); return;
    }
    const command = positionals[0];
    if (!command || !Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command ?? ''}; use --help`);
    const permitted = allowed[command];
    if (!permitted) throw new Error('Invalid command');
    for (const name of Object.keys(values)) {
      if (name !== 'state' && !permitted.includes(name)) throw new Error(`--${name} is not supported by ${command}`);
    }
    const hasOperand = ['add', 'submit', 'resume-native', 'claim', 'verify-claim', 'done', 'block', 'retry', 'recover', 'reconcile-delivery', 'complete-merged'].includes(command);
    if (positionals.length !== (hasOperand ? 2 : 1)) throw new Error(`${command} expects ${hasOperand ? 'one argument' : 'no arguments'}`);
    const state = statePath(values.state ?? process.env.REPO_QUEUE_STATE ?? resolve(homedir(), '.local/state/repo-queue'));
    let result: unknown;
    switch (command) {
      case 'serve': await serve(state); return;
      case 'start': await start(state); result = { dispatcher_running: true }; break;
      case 'stop': await stop(state); result = { stop_requested: true, reservations_retained: true }; break;
      case 'doctor': {
        const agents = values.agent ? [agent(values.agent)] : ['codex', 'claude'];
        const checks = await Promise.all(agents.map(async (name) => {
          try {
            const { stdout } = await promisify(execFile)(name, ['--version'], { timeout: 10_000, maxBuffer: 16_384 });
            return { agent: name, available: true, version: stdout.trim() };
          } catch { return { agent: name, available: false }; }
        }));
        result = { node: process.version, platform: process.platform, state, agents: checks };
        break;
      }
      default: {
        store = new Store(state);
        if (command === 'status') {
          const ledger = new DeliveryLedger(state);
          try {
            const entries = store.list();
            result = {
              dispatcher_running: await running(state),
              entries,
              delivery_alerts: overdueCodexClaims(entries),
              delivery_attempts: ledger.list(),
              administrative_completions: store.administrativeCompletions(),
            };
          } finally { ledger.close(); }
          break;
        }
        if (command === 'add' || command === 'submit') {
          const task = required(values.task, '--task');
          if (!uuid.test(task)) throw new Error('--task must be the original conversation UUID');
          const owner = agent(values.agent);
          validateCodexOwner(owner, task);
          const cwd = realpathSync(values.cwd ?? process.cwd());
          if (!statSync(cwd).isDirectory()) throw new Error('--cwd must be a directory');
          const url = required(positionals[1], 'PR URL');
          let native;
          if (command === 'submit') {
            if (!values['authorize-merge']) throw new Error('submit requires --authorize-merge: explicit authority for required queue validation and merge');
            const parsed = pullRequest(url);
            if (parsed.provider === 'github') {
              const observed = await github.inspect(parsed.repo, parsed.prNumber);
              if (observed.required) {
                if (observed.state !== 'OPEN') throw new Error('submit requires an open PR');
                if (observed.members.length > 1 && !values.stack) throw new Error('GitHub will queue the lower stack members too; use --stack only when that whole prefix is authorized');
                native = { base: observed.base, head: observed.head, members: observed.members };
              }
            }
          }
          result = store.add({
            ...(native === undefined ? {} : { native }),
            url, agent: owner, task, cwd,
            ...(values.desktop ? { desktop: true } : {}),
            ...(values.checkpoint === undefined ? {} : { checkpoint_path: resolve(cwd, required(values.checkpoint, '--checkpoint')) }),
          });
          break;
        }
        const id = required(positionals[1], 'entry ID');
        const token = required(values.token, '--token');
        switch (command) {
          case 'resume-native': {
            const entry = store.verifyOwnership(id, token);
            if (!entry.native || entry.state !== 'claimed') throw new Error('resume-native requires the original claimed native repair turn');
            if (entry.native.state === 'uncertain' && !values.quiescent) throw new Error('Uncertain submission requires --quiescent after confirming the remote request cannot still execute');
            const observed = await github.inspect(entry.repo, entry.pr_number);
            if (observed.state === 'MERGED') {
              store.updateNative(id, entry.native, { ...entry.native, state: 'merged', detail: 'GitHub confirms this pull request is merged.' });
              result = store.verifyOwnership(id, token);
              break;
            }
            if (!observed.required || observed.state !== 'OPEN') throw new Error('Reconcile the PR and effective queue before resuming; it must be open and require the queue');
            if (entry.native.request !== null && entry.native.state !== 'failed' && observed.queue === null) {
              const request = await github.result(entry.repo, entry.pr_number, entry.native.request);
              if (request.status !== 'failed' && !(request.status === 'unavailable' && values.quiescent)) throw new Error('The prior asynchronous request is not confirmed failed; reconcile it before resuming');
            }
            result = store.resumeNative(id, token, observed);
            break;
          }
          case 'claim': result = store.claim(id, token); break;
          case 'verify-claim': {
            const task = required(values.task, '--task');
            if (!uuid.test(task)) throw new Error('--task must be the original conversation UUID');
            const cwd = realpathSync(values.cwd ?? process.cwd());
            if (!statSync(cwd).isDirectory()) throw new Error('--cwd must be a directory');
            result = store.verifyClaim(id, token, {
              agent: agent(values.agent),
              task,
              cwd,
            });
            break;
          }
          case 'done': result = store.done(id, token); break;
          case 'block': result = store.block(id, token, required(values.reason, '--reason')); break;
          case 'retry': result = store.retry(id, token); break;
          case 'recover':
            if (!values.quiescent) throw new Error('Recovery requires --quiescent: confirm the old owner and remote jobs have stopped');
            result = store.recover(id, token); break;
          case 'reconcile-delivery': {
            if (!values.quiescent) {
              throw new Error('Delivery reconciliation requires --quiescent: confirm the delivery child has stopped');
            }
            const ownerStore = store;
            const ledger = new DeliveryLedger(state);
            try {
              result = ledger.reconcileUnknown(id, true, () => ownerStore.verifyOwnership(id, token));
            } finally { ledger.close(); }
            break;
          }
          case 'complete-merged': {
            if (!values.quiescent) throw new Error('Administrative completion requires --quiescent: confirm the owner and remote work have stopped');
            const reason = required(values.reason, '--reason');
            const entry = store.administrativeCandidate(id, token);
            const ledger = new DeliveryLedger(state);
            try {
              const noAttempt = (): void => {
                if (ledger.list().some((attempt) => attempt.entry_id === id)) {
                  throw new Error('Delivery attempt is active or unreconciled; resolve it before administrative completion');
                }
              };
              noAttempt();
              const merged = await verifyMergedGithub(entry);
              noAttempt();
              const completed = store.completeMerged(id, token, reason, merged.url, merged.mergedAt);
              result = {
                entry_id: completed.id,
                state: completed.state,
                administrative_completion: store.administrativeCompletions().find((audit) => audit.entry_id === id),
              };
            } finally { ledger.close(); }
            break;
          }
          default: throw new Error('Unknown command');
        }
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown failure';
    process.stderr.write(`repo-queue: ${message}\n`);
    process.exitCode = 1;
  } finally { store?.close(); }
}

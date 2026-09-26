import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const nativeStates = ['admission_pending', 'submitting', 'enqueued', 'validating', 'failed', 'uncertain', 'merged'] as const;
export type NativeState = typeof nativeStates[number];
export interface NativePlan {
  base: string;
  head: string;
  members: { number: number; head: string }[];
}
export interface NativeQueue extends NativePlan {
  authorized_at: string;
  state: NativeState;
  request: string | null;
  detail: string;
  next_check: number;
}
export interface GithubObservation extends NativePlan {
  required: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  queue: 'QUEUED' | 'AWAITING_CHECKS' | 'LOCKED' | 'MERGEABLE' | 'UNMERGEABLE' | null;
}
export type AsyncResult =
  | { status: 'pending'; request: string; head: string; action: string }
  | { status: 'enqueued' | 'merged' | 'failed' | 'unavailable'; message: string };

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid GitHub object');
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error('Invalid GitHub string');
  return value;
}
function sha(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error('Invalid GitHub head SHA');
  return result;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid GitHub number');
  return value;
}
export function parseNative(value: unknown): NativeQueue {
  const row = object(value);
  const state = nativeStates.find((state) => state === row.state);
  if (!state) throw new Error('Invalid native queue state');
  if (!Array.isArray(row.members) || row.members.length === 0) throw new Error('Invalid native queue members');
  const members = row.members.map((value: unknown) => {
    const member = object(value);
    return { number: number(member.number), head: sha(member.head) };
  });
  const authorized = string(row.authorized_at);
  if (!Number.isFinite(Date.parse(authorized)) || typeof row.next_check !== 'number' || !Number.isFinite(row.next_check)) throw new Error('Invalid native queue time');
  if (typeof row.detail !== 'string' || row.detail.length > 4096) throw new Error('Invalid native queue detail');
  return { base: string(row.base), head: sha(row.head), members, authorized_at: authorized, state,
    request: row.request === null ? null : string(row.request), detail: row.detail, next_check: row.next_check };
}

export interface Github {
  inspect(repo: string, pr: number): Promise<GithubObservation>;
  submit(repo: string, pr: number, head: string): Promise<AsyncResult>;
  result(repo: string, pr: number, request: string): Promise<AsyncResult>;
}

class GithubRequestError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined) {
    super('GitHub API request failed; inspect authentication and provider availability');
    this.status = status;
  }
}

async function api(args: string[], acceptedErrors: number[] = []): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)('gh', ['api', '--hostname', 'github.com', ...args], {
      timeout: 20_000, maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    // gh emits the JSON response even for a documented non-2xx merge result.
    const match = error instanceof Error ? /\(HTTP (\d{3})\)/.exec(error.message) : null;
    const status = match?.[1] === undefined ? undefined : Number(match[1]);
    if (!(error instanceof Error) || typeof Reflect.get(error, 'stdout') !== 'string' ||
      status === undefined || !acceptedErrors.includes(status)) throw new GithubRequestError(status);
    stdout = string(Reflect.get(error, 'stdout'));
  }
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed === 'object' && parsed !== null && 'errors' in parsed) throw new Error('GitHub GraphQL returned errors');
  return parsed;
}
const headers = ['-H', 'X-GitHub-Api-Version: 2026-03-10'];
function path(repo: string): string {
  if (!/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Native queue requires a GitHub repository');
  return `/repos/${repo.slice('github.com/'.length)}`;
}
function parseResult(value: unknown): AsyncResult {
  const row = object(value);
  const details = object(row.details);
  if (row.status === 'pending') return { status: 'pending', request: string(details.uuid), head: sha(details.expected_head_sha), action: string(details.merge_action) };
  if (row.status === 'enqueued' || row.status === 'merged' || row.status === 'failed') return { status: row.status, message: string(details.message) };
  throw new Error('Unknown GitHub asynchronous merge result');
}

/** GitHub's stack-aware API explicitly requests a queue, never a direct merge. */
export const github: Github = {
  async inspect(repo, pr) {
    const endpoint = path(repo);
    const pull = object(await api([`${endpoint}/pulls/${pr}`, ...headers]));
    if (number(pull.number) !== pr || string(pull.html_url).toLowerCase() !== `https://${repo}/pull/${pr}`) throw new Error('GitHub returned a different pull request');
    const head = sha(object(pull.head).sha);
    let base = string(object(pull.base).ref);
    let members = [{ number: pr, head }];
    const [owner, name] = repo.slice('github.com/'.length).split('/');
    const response = object(await api(['graphql', '-f', 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state headRefOid mergeQueueEntry{state}}}}', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]));
    const node = object(object(object(response.data).repository).pullRequest);
    if (sha(node.headRefOid) !== head) throw new Error('GitHub PR head changed while reading');
    if (node.state !== 'OPEN' && node.state !== 'CLOSED' && node.state !== 'MERGED') throw new Error('Invalid GitHub PR state');
    const queue = node.mergeQueueEntry === null ? null : object(node.mergeQueueEntry).state;
    if (queue !== null && queue !== 'QUEUED' && queue !== 'AWAITING_CHECKS' && queue !== 'LOCKED' && queue !== 'MERGEABLE' && queue !== 'UNMERGEABLE') throw new Error('Unknown GitHub queue state');
    if (node.state !== 'OPEN') return { base, head, members, required: false, state: node.state, queue };
    if (pull.stack !== null && pull.stack !== undefined) {
      const stack = object(pull.stack);
      base = string(object(stack.base).ref);
      const result = object(await api([`${endpoint}/stacks/${number(stack.number)}`, ...headers]));
      if (string(object(result.base).ref) !== base || !Array.isArray(result.pull_requests)) throw new Error('GitHub stack changed while reading');
      const pulls = result.pull_requests.map((value: unknown) => object(value));
      const index = pulls.findIndex((member) => member.number === pr);
      if (index < 0) throw new Error('GitHub stack omitted the requested PR');
      members = pulls.slice(0, index + 1).filter((member) => member.merged_at === null).map((member) => ({ number: number(member.number), head: sha(object(member.head).sha) }));
      if (members.at(-1)?.head !== head) throw new Error('GitHub stack head changed while reading');
    }
    const rules = await api([`${endpoint}/rules/branches/${encodeURIComponent(base)}?per_page=100`, '--paginate', '--slurp', ...headers]);
    if (!Array.isArray(rules) || !rules.every(Array.isArray)) throw new Error('Invalid effective GitHub rules');
    const required = rules.flat().map((rule: unknown) => string(object(rule).type)).includes('merge_queue');
    return { base, head, members, required, state: node.state, queue };
  },
  async submit(repo, pr, head) {
    return parseResult(await api([`${path(repo)}/pulls/${pr}/merge-async`, '--method', 'PUT', '-f', `sha=${head}`, '-f', 'merge_action=merge_queue', ...headers], [400, 409]));
  },
  async result(repo, pr, request) {
    try {
      return parseResult(await api([`${path(repo)}/pulls/${pr}/merge-async/${encodeURIComponent(request)}`, ...headers]));
    } catch (error) {
      if (error instanceof GithubRequestError && error.status === 404) return { status: 'unavailable', message: 'GitHub no longer exposes this asynchronous request; reconcile expiry or access before retrying.' };
      throw error;
    }
  },
};

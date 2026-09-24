import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Entry } from './types.ts';

export interface MergedPullRequest {
  url: string;
  mergedAt: string;
}

/** Ask the installed GitHub CLI for the exact PR's remote merge state. */
export async function verifyMergedGithub(entry: Readonly<Entry>): Promise<MergedPullRequest> {
  if (entry.provider !== 'github') throw new Error('Administrative completion currently supports GitHub PRs only');
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      'gh', ['pr', 'view', entry.url, '--json', 'state,mergedAt,url'],
      { timeout: 20_000, maxBuffer: 64_000 },
    ));
  } catch {
    throw new Error('GitHub merge verification failed; inspect gh authentication and the saved PR URL');
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('GitHub merge verification returned invalid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GitHub merge verification returned an invalid PR');
  }
  const state = Reflect.get(value, 'state');
  const url = Reflect.get(value, 'url');
  const mergedAt = Reflect.get(value, 'mergedAt');
  if (typeof url !== 'string' || url.toLowerCase().replace(/\/$/, '') !== entry.url ||
    state !== 'MERGED' || typeof mergedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(mergedAt)) {
    throw new Error('GitHub did not confirm the exact saved PR as merged');
  }
  return { url: entry.url, mergedAt };
}

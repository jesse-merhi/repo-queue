import { github, type AsyncResult, type Github, type NativeQueue } from './native.ts';
import type { Store } from './store.ts';

const interval = 30_000;

function recordResult(store: Store, id: string, saved: NativeQueue, result: AsyncResult): void {
  let next: NativeQueue;
  let notify = false;
  if (result.status === 'pending') {
    const matches = result.head === saved.head && result.action === 'merge_queue';
    next = {
      ...saved, request: result.request, state: matches ? 'admission_pending' : 'uncertain',
      detail: matches ? 'GitHub is evaluating admission requirements; queue membership is not yet confirmed.' : 'Existing asynchronous request has different options; reconcile it before retrying.',
    };
    notify = !matches;
  } else if (result.status === 'unavailable') {
    next = { ...saved, state: 'uncertain', detail: result.message };
    notify = true;
  } else if (result.status === 'failed') {
    next = { ...saved, state: 'failed', detail: result.message };
    notify = true;
  } else if (result.status === 'enqueued') {
    next = { ...saved, state: 'enqueued', detail: result.message };
  } else {
    // Verify the PR's merged state independently before completing local ownership.
    next = { ...saved, detail: result.message };
  }
  store.updateNative(id, saved, { ...next, next_check: Date.now() + interval }, notify);
}

/** One durable pass; provider calls never wake a model unless an owner has work to do. */
export async function monitorNative(store: Store, provider: Github = github, stopped: () => boolean = () => false): Promise<void> {
  for (const entry of store.list()) {
    const saved = entry.native;
    if (!saved || saved.state === 'merged' || saved.next_check > Date.now() || stopped()) continue;
    const update = (changes: Partial<NativeQueue>, notify = false): boolean => {
      if (stopped()) return false;
      return store.updateNative(entry.id, saved, { ...saved, next_check: Date.now() + interval, ...changes }, notify);
    };
    try {
      const observed = await provider.inspect(entry.repo, entry.pr_number);
      if (stopped()) return;
      if (observed.state === 'MERGED') {
        update({ state: 'merged', detail: 'GitHub confirms this pull request is merged.' });
        continue;
      }
      if (entry.state !== 'waiting') {
        update({});
        continue;
      }
      if (observed.state === 'CLOSED') {
        update({ state: 'failed', detail: 'GitHub reports this pull request closed without merging.' }, true);
        continue;
      }
      if (observed.queue !== null) {
        if (observed.queue === 'UNMERGEABLE') {
          update({ state: 'failed', detail: 'GitHub reports the queue entry unmergeable.' }, true);
        } else {
          update({ state: observed.queue === 'AWAITING_CHECKS' ? 'validating' : 'enqueued', detail: `GitHub queue state: ${observed.queue}` });
        }
        continue;
      }
      if (saved.state === 'enqueued' || saved.state === 'validating') {
        update({ state: 'failed', detail: 'GitHub no longer lists the previously observed queue entry; it was removed or ejected.' }, true);
        continue;
      }
      if (saved.request !== null) {
        const result = await provider.result(entry.repo, entry.pr_number, saved.request);
        if (!stopped()) recordResult(store, entry.id, saved, result);
        continue;
      }
      if (saved.state === 'submitting' || saved.state === 'uncertain') {
        update({ state: 'uncertain', detail: 'Submission outcome is unknown after interruption. Inspect GitHub and establish that no request remains before resuming.' }, true);
        continue;
      }
      if (!observed.required || observed.base !== saved.base || observed.head !== saved.head ||
        JSON.stringify(observed.members) !== JSON.stringify(saved.members)) {
        update({ state: 'failed', detail: 'Effective queue requirement, base, head or stack membership changed; the original owner must reconcile the candidate.' }, true);
        continue;
      }
      const submitting: NativeQueue = { ...saved, state: 'submitting', detail: 'Submitting the authorized candidate to GitHub.', next_check: Date.now() + interval };
      if (stopped() || !store.updateNative(entry.id, saved, submitting)) continue;
      try {
        const result = await provider.submit(entry.repo, entry.pr_number, saved.head);
        if (stopped()) continue;
        recordResult(store, entry.id, submitting, result);
      } catch {
        if (!stopped()) store.updateNative(entry.id, submitting, { ...submitting, state: 'uncertain', detail: 'GitHub submission outcome is unknown; inspect the provider before retrying.' }, true);
      }
    } catch {
      // A read outage changes neither provider state nor authorization. Back off durably.
      update({ detail: 'GitHub observation failed; retaining the last confirmed state and retrying in 30 seconds.' });
    }
  }
}

import type { Entry } from './types.ts';

export const codexClaimGraceMs = 5 * 60_000;

export interface ClaimAlert {
  readonly code: 'codex_claim_overdue' | 'codex_activation_request_failed';
  readonly entry_id: string;
  readonly task: string;
  readonly accepted_at: string;
  readonly message: string;
}

/** Native acceptance does not establish that the original Codex task loaded or claimed. */
export function overdueCodexClaims(entries: readonly Entry[], nowMs = Date.now()): ClaimAlert[] {
  return entries.flatMap<ClaimAlert>((entry) => {
    if (entry.agent !== 'codex' || entry.state !== 'reserved' || entry.delivery_status !== 'sent') {
      return [];
    }
    if (entry.delivery_error) {
      return [{
        code: 'codex_activation_request_failed' as const,
        entry_id: entry.id,
        task: entry.task,
        accepted_at: entry.updated_at,
        message: 'The desktop activation request failed after native queue acceptance. ' +
          'The original task has not claimed its turn. Inspect that task before intervening; ' +
          'do not resend the queued message or start another owner.',
      }];
    }
    const acceptedAt = Date.parse(entry.updated_at);
    if (!Number.isFinite(acceptedAt) || nowMs - acceptedAt < codexClaimGraceMs) return [];
    return [{
      code: 'codex_claim_overdue' as const,
      entry_id: entry.id,
      task: entry.task,
      accepted_at: entry.updated_at,
      message: 'Codex accepted the wake, but the original task has not claimed its turn. ' +
        'Inspect that exact task. If it is not loaded, send one follow-up to that task through the Codex app. ' +
        'Do not start another owner or retry the queued message without checking for active work.',
    }];
  });
}

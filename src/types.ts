import type { NativePlan, NativeQueue } from './native.ts';
export const agents = ["codex", "claude"] as const;
export type Agent = (typeof agents)[number];

export const providers = ["github", "bitbucket"] as const;
export type Provider = (typeof providers)[number];

export const queueStates = [
  "waiting",
  "reserved",
  "claimed",
  "blocked",
  "done",
] as const;
export type QueueState = (typeof queueStates)[number];

export const deliveryStatuses = [
  "pending",
  "sending",
  "sent",
  "failed",
  "uncertain",
] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export interface Entry {
  native?: NativeQueue;
  sequence: number;
  id: string;
  url: string;
  provider: Provider;
  repo: string;
  pr_number: number;
  agent: Agent;
  task: string;
  cwd: string;
  owner_config_root?: string;
  owner_config_explicit?: boolean;
  desktop?: boolean;
  checkpoint_path?: string;
  state: QueueState;
  token: string | null;
  block_reason: string;
  delivery_status: DeliveryStatus;
  delivery_error: string;
  created_at: string;
  updated_at: string;
}

export interface AddEntryInput {
  native?: NativePlan;
  url: string;
  agent: Agent;
  task: string;
  cwd: string;
  owner_config_root?: string;
  desktop?: boolean;
  checkpoint_path?: string;
}

export interface AdministrativeCompletion {
  entry_id: string;
  reason: string;
  verified_url: string;
  merged_at: string;
  completed_at: string;
}

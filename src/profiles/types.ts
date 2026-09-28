import type { ProfileRuntime } from "./profile-runtime.js";

export type ProfileId = string;

export type ProfileState =
  | "ready"
  | "busy"
  | "cooldown"
  | "quota_exhausted"
  | "auth_required"
  | "unhealthy"
  | "disabled";

export type ProfileFailureKind =
  | "rate_limit"
  | "quota_exhausted"
  | "auth"
  | "transient"
  | "fatal";

export interface ProfileFailureClassification {
  kind: ProfileFailureKind;
  retryableOnAnotherProfile: boolean;
  cooldownMs?: number | undefined;
  reason?: string | undefined;
}

export interface ProfileConfig {
  id: ProfileId;
  geminiHome: string;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  sessionMode?: "default" | "auto_edit" | "yolo" | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface ProfileSnapshot {
  id: ProfileId;
  geminiHome: string;
  priority: number;
  enabled: boolean;
  sessionMode: "default" | "auto_edit" | "yolo";
  state: ProfileState;
  activeLeases: number;
  cooldownUntil?: string | undefined;
  lastFailureKind?: ProfileFailureKind | undefined;
  lastError?: string | undefined;
  lastSuccessAt?: string | undefined;
  lastFailureAt?: string | undefined;
}

export interface ProfileLease {
  readonly profile: ProfileRuntime;
  release(): void;
}

export interface AcquireOptions {
  preferredProfileId?: string | undefined;
  excludeProfileIds?: Iterable<string> | undefined;
  eligibleProfileIds?: Iterable<string> | undefined;
}

export interface FailoverOptions extends AcquireOptions {
  classifyFailure?: ((error: unknown) => ProfileFailureClassification) | undefined;
  maxAttempts?: number | undefined;
}

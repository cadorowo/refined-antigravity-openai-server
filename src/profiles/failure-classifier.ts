import type { ProfileFailureClassification } from "./types.js";

function extractErrorText(error: unknown): string {
  if (error instanceof Error) {
    let text = `${error.name}: ${error.message}`;
    if ("rpcCode" in error) {
      text += ` rpcCode=${String((error as { rpcCode?: unknown }).rpcCode)}`;
    }
    if ("rpcData" in error && (error as { rpcData?: unknown }).rpcData !== undefined) {
      text += ` rpcData=${JSON.stringify((error as { rpcData?: unknown }).rpcData)}`;
    }
    if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
      text += ` code=${String((error as { code?: unknown }).code)}`;
    }
    return text.toLowerCase();
  }
  return String(error).toLowerCase();
}

/**
 * Conservative classifier for profile-scoped errors.
 * Only clearly identifiable quota, rate-limit, auth, or transient network/upstream
 * errors trigger failover to another profile. Unknown errors are classified as
 * fatal so implementation bugs are not masked.
 */
export function classifyProfileFailure(error: unknown): ProfileFailureClassification {
  const text = extractErrorText(error);

  // Authentication failures
  if (
    text.includes("authentication required") ||
    text.includes("auth_required") ||
    text.includes("not authenticated") ||
    text.includes("login required") ||
    text.includes("unauthenticated") ||
    text.includes("invalid_grant") ||
    text.includes("token expired") ||
    text.includes("http 401") ||
    text.includes("status 401") ||
    text.includes("code: 401") ||
    text.includes("http 403") ||
    text.includes("status 403") ||
    text.includes("code: 403")
  ) {
    return {
      kind: "auth",
      retryableOnAnotherProfile: true,
      reason: "Authentication required or credentials invalid",
    };
  }

  // Quota exhaustion
  if (
    text.includes("resource_exhausted") ||
    text.includes("quota exhausted") ||
    text.includes("quota exceeded") ||
    text.includes("quota_exceeded") ||
    text.includes("daily limit") ||
    text.includes("usage limit")
  ) {
    return {
      kind: "quota_exhausted",
      retryableOnAnotherProfile: true,
      reason: "Account quota exhausted",
    };
  }

  // Rate limiting (retryable after cooldown)
  if (
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("rate-limit") ||
    text.includes("too many requests") ||
    text.includes("429") ||
    text.includes("throttled")
  ) {
    return {
      kind: "rate_limit",
      retryableOnAnotherProfile: true,
      cooldownMs: 60_000,
      reason: "Rate limit encountered",
    };
  }

  // Transient infrastructure/network errors
  if (
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("bad gateway") ||
    text.includes("service unavailable") ||
    text.includes("temporarily unavailable") ||
    text.includes("connection reset") ||
    text.includes("econnreset") ||
    text.includes("socket hang up") ||
    text.includes("econnrefused") ||
    text.includes("etimedout")
  ) {
    return {
      kind: "transient",
      retryableOnAnotherProfile: true,
      cooldownMs: 15_000,
      reason: "Transient upstream or connection error",
    };
  }

  // Unclassified or fatal error: do NOT retry
  return {
    kind: "fatal",
    retryableOnAnotherProfile: false,
    reason: "Unclassified or fatal error",
  };
}

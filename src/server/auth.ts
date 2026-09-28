import crypto from "node:crypto";

/**
 * Validates an incoming Authorization header against the configured API key.
 *
 * Rules:
 * 1. If server has no API key configured, returns true (open server).
 * 2. If server has an API key configured, requires "Bearer <token>" matching
 *    the key exactly.
 * 3. Compares tokens using crypto.timingSafeEqual to prevent timing attacks,
 *    handling differing buffer lengths safely.
 * 4. Never logs or leaks token values.
 */
export function verifyBearerAuth(
  authHeader: string | undefined,
  expectedApiKey: string | undefined,
): boolean {
  // If no API key configured, authentication is not enforced
  if (!expectedApiKey || expectedApiKey.trim().length === 0) {
    return true;
  }

  if (!authHeader) {
    return false;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return false;
  }

  const providedToken = match[1].trim();
  const providedBuf = Buffer.from(providedToken);
  const expectedBuf = Buffer.from(expectedApiKey);

  // Buffer lengths must match for timingSafeEqual
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

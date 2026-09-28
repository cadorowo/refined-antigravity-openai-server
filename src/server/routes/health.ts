import { verifyBearerAuth } from "../auth.js";
import { invalidApiKeyError, methodNotAllowedError } from "../errors.js";
import { type RequestContext, sendError, sendJson } from "../request-context.js";

/**
 * Liveness probe: GET /healthz
 * Indicates whether the server process is alive and its basic runtime loop is functioning.
 * Does not require Bearer authentication.
 * Returns HTTP 200 "ok" as long as the process is alive, even if profiles are temporarily busy/cooldown.
 */
export function handleHealth(context: RequestContext): void {
  const { req, res, requestId, profileManager } = context;

  if (req.method !== "GET") {
    sendError(
      res,
      methodNotAllowedError(req.method ?? "UNKNOWN", "/healthz", ["GET"]),
      requestId,
      { Allow: "GET" },
    );
    return;
  }

  const snapshots = profileManager.snapshots();

  const counts = {
    total: snapshots.length,
    ready: 0,
    busy: 0,
    cooldown: 0,
    quota_exhausted: 0,
    auth_required: 0,
    unhealthy: 0,
    disabled: 0,
  };

  for (const s of snapshots) {
    if (s.state in counts) {
      counts[s.state as keyof typeof counts]++;
    }
  }

  const availableCount = counts.ready + counts.busy + counts.cooldown;
  const status = availableCount > 0 ? "ok" : "degraded";

  const payload = {
    status,
    version: "0.1.0",
    uptime: Math.round(process.uptime() * 100) / 100,
    profiles: counts,
  };

  sendJson(res, 200, payload, requestId);
}

/**
 * Readiness probe: GET /readyz
 * Indicates whether at least one profile is immediately ready to accept a new request.
 * Returns HTTP 200 "ready" if >= 1 profile has state "ready" and server is not draining.
 * Returns HTTP 503 "not_ready" if no profile can accept work or server is shutting down.
 * Does not require Bearer authentication.
 */
export function handleReady(context: RequestContext): void {
  const { req, res, requestId, profileManager, isDraining } = context;

  if (req.method !== "GET") {
    sendError(
      res,
      methodNotAllowedError(req.method ?? "UNKNOWN", "/readyz", ["GET"]),
      requestId,
      { Allow: "GET" },
    );
    return;
  }

  const snapshots = profileManager.snapshots();
  const availableCount = snapshots.filter((s) => s.state === "ready").length;

  if (isDraining) {
    sendJson(
      res,
      503,
      {
        status: "not_ready",
        reason: "server_draining",
        profiles: {
          total: snapshots.length,
          available: 0,
        },
      },
      requestId,
    );
    return;
  }

  if (availableCount > 0) {
    sendJson(
      res,
      200,
      {
        status: "ready",
        profiles: {
          total: snapshots.length,
          available: availableCount,
        },
      },
      requestId,
    );
  } else {
    sendJson(
      res,
      503,
      {
        status: "not_ready",
        profiles: {
          total: snapshots.length,
          available: 0,
        },
      },
      requestId,
    );
  }
}

/**
 * Protected operational status report: GET /status
 * Requires Bearer authentication (same key as /v1/*).
 * Returns machine-readable metrics and health summary without sensitive credentials or paths.
 */
export function handleStatus(context: RequestContext): void {
  const { req, res, requestId, config, profileManager, responseRegistry, metrics, isDraining } = context;

  if (req.method !== "GET") {
    sendError(
      res,
      methodNotAllowedError(req.method ?? "UNKNOWN", "/status", ["GET"]),
      requestId,
      { Allow: "GET" },
    );
    return;
  }

  const authHeader = req.headers["authorization"];
  const isAuthorized = verifyBearerAuth(authHeader, config.apiKey);
  if (!isAuthorized) {
    sendError(res, invalidApiKeyError(), requestId);
    return;
  }

  const report = metrics.snapshot({
    isDraining: isDraining ?? false,
    responseRegistryEntries: responseRegistry.size,
    profiles: profileManager.snapshots(),
  });

  sendJson(res, 200, report, requestId);
}

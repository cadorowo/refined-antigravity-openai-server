import crypto from "node:crypto";
import type http from "node:http";

import type { ModelCatalog } from "../openai/models.js";
import type { ResponseRegistry } from "../openai/response-registry.js";
import type { ProfileManager } from "../profiles/profile-manager.js";
import {
  OpenAIHttpError,
  internalServerError,
  payloadTooLargeError,
} from "./errors.js";
import type { ServerConfig } from "./config.js";

import type { RuntimeMetrics } from "./metrics.js";
import type { ServerLogger } from "./logger.js";
export type { ServerLogger };
export { DefaultServerLogger, NoopServerLogger, sanitizeLogString, sanitizeLogContext } from "./logger.js";

export interface RequestContext {
  readonly requestId: string;
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly url: URL;
  readonly pathname: string;
  readonly startTimeMs: number;
  readonly profileManager: ProfileManager;
  readonly modelCatalog: ModelCatalog;
  readonly responseRegistry: ResponseRegistry;
  readonly metrics: RuntimeMetrics;
  readonly config: ServerConfig;
  readonly logger: ServerLogger;
  readonly isDraining?: boolean | undefined;
}


/**
 * Generates an opaque, traceable request identifier.
 */
export function generateRequestId(): string {
  return `req_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Reads and parses JSON request body with strict byte limit enforcement.
 */
export async function readJsonBody<T = unknown>(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let receivedBytes = 0;
    const chunks: Buffer[] = [];

    const onData = (chunk: Buffer): void => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        req.pause();
        cleanup();
        reject(payloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      cleanup();
      if (chunks.length === 0) {
        resolve({} as T);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed as T);
      } catch {
        reject(
          new OpenAIHttpError(400, "Invalid JSON in request body", {
            code: "invalid_payload",
          }),
        );
      }
    };

    const onError = (err: unknown): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * Sends a structured JSON HTTP response with x-request-id header.
 */
export function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) {
    return;
  }

  const jsonBody = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(jsonBody).toString(),
    "x-request-id": requestId,
    ...extraHeaders,
  };

  res.writeHead(statusCode, headers);
  res.end(jsonBody);
}

/**
 * Formats and sends an error response using the OpenAI error schema.
 */
export function sendError(
  res: http.ServerResponse,
  error: unknown,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (error instanceof OpenAIHttpError) {
    sendJson(res, error.statusCode, error.toPayload(), requestId, extraHeaders);
    return;
  }

  const fallback = internalServerError();
  sendJson(res, 500, fallback.toPayload(), requestId, extraHeaders);
}

/**
 * Prepares the HTTP response for Server-Sent Events (SSE).
 */
export function initSseStream(
  res: http.ServerResponse,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) {
    return;
  }

  const headers: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": requestId,
    ...extraHeaders,
  };

  res.writeHead(200, headers);
}

/** Waits for socket backpressure before consuming another upstream update. */
export function writeSseChunk(
  res: http.ServerResponse,
  chunk: string,
  signal?: AbortSignal,
): Promise<void> {
  if (res.destroyed || res.writableEnded || signal?.aborted) {
    return Promise.reject(new Error("SSE client disconnected"));
  }
  if (res.write(chunk)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("SSE client disconnected")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(new Error("SSE request aborted")); };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (res.destroyed || res.writableEnded || signal?.aborted) onAbort();
  });
}

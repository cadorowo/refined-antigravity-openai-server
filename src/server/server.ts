import http from "node:http";

import { ModelCatalog } from "../openai/models.js";
import { ResponseRegistry } from "../openai/response-registry.js";
import type { ProfileManager } from "../profiles/profile-manager.js";
import {
  type ServerConfig,
  type ServerConfigInput,
  loadConfigFromEnv,
  validateConfig,
} from "./config.js";
import { routeNotFoundError } from "./errors.js";
import {
  DefaultServerLogger,
  NoopServerLogger,
  type ServerLogger,
} from "./logger.js";
import { RuntimeMetrics } from "./metrics.js";
import {
  type RequestContext,
  generateRequestId,
  sendError,
} from "./request-context.js";
import { handleChatCompletions } from "./routes/chat-completions.js";
import { handleHealth, handleReady, handleStatus } from "./routes/health.js";
import { handleModels } from "./routes/models.js";
import { handleGetResponse, handleResponses } from "./routes/responses.js";

export { DefaultServerLogger, NoopServerLogger };

export interface CreateServerOptions {
  profileManager: ProfileManager;
  config?: ServerConfigInput | undefined;
  logger?: ServerLogger | undefined;
  modelCatalog?: ModelCatalog | undefined;
  responseRegistry?: ResponseRegistry | undefined;
  metrics?: RuntimeMetrics | undefined;
}

interface ActiveRequestRecord {
  abortController: AbortController;
  donePromise: Promise<void>;
  markDone: () => void;
}

export class RefinedOpenAiServer {
  public readonly server: http.Server;
  public readonly config: ServerConfig;
  public readonly profileManager: ProfileManager;
  public readonly modelCatalog: ModelCatalog;
  public readonly responseRegistry: ResponseRegistry;
  public readonly metrics: RuntimeMetrics;
  public readonly logger: ServerLogger;

  private isStarted = false;
  private isClosed = false;
  private isDraining = false;
  private readonly activeRequests = new Set<ActiveRequestRecord>();

  constructor(options: CreateServerOptions) {
    this.profileManager = options.profileManager;
    this.config = loadConfigFromEnv(options.config);
    this.logger = options.logger ?? new DefaultServerLogger();
    this.metrics = options.metrics ?? new RuntimeMetrics();

    this.modelCatalog =
      options.modelCatalog ??
      new ModelCatalog({
        profileManager: this.profileManager,
        logger: this.logger,
      });

    this.responseRegistry =
      options.responseRegistry ??
      new ResponseRegistry({
        maxEntries: this.config.responseRegistryMaxEntries,
        ttlMs: this.config.responseRegistryTtlMs,
        logger: this.logger,
      });

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }


  public get port(): number {
    const address = this.server.address();
    if (address && typeof address === "object") {
      return address.port;
    }
    return this.config.port;
  }

  public async start(): Promise<void> {
    if (this.isClosed) {
      throw new Error("Cannot start a closed RefinedOpenAiServer");
    }
    if (this.isStarted) {
      return;
    }

    validateConfig(this.config);

    // 1. Eager profile startup
    this.logger.info("Eagerly starting Antigravity profiles...", {
      count: this.profileManager.list().length,
    });
    const results = await this.profileManager.startAll();
    let startedOk = 0;
    for (const res of results) {
      if (res.status === "fulfilled") {
        startedOk++;
      }
    }
    this.logger.info("Antigravity profiles initialized", {
      total: results.length,
      started: startedOk,
    });

    // 2. Start HTTP listener with start failure cleanup
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          this.server.removeListener("error", onError);
          reject(err);
        };
        this.server.once("error", onError);

        this.server.listen(this.config.port, this.config.host, () => {
          this.server.removeListener("error", onError);
          this.isStarted = true;
          resolve();
        });
      });

      this.logger.info("refined-antigravity-openai-server started", {
        host: this.config.host,
        port: this.port,
      });
    } catch (startError) {
      this.logger.error("Server bind failed, performing cleanup", startError);
      await this.close().catch(() => {});
      throw startError;
    }
  }

  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.isDraining = true;

    this.logger.info("Shutting down RefinedOpenAiServer...");

    // 1. Stop accepting new HTTP requests
    let serverClosePromise: Promise<void> | undefined;
    if (this.server.listening) {
      serverClosePromise = new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
    }

    // 2. Wait for active requests to finish within shutdownGraceMs
    if (this.activeRequests.size > 0) {
      this.logger.info("Draining active requests...", {
        activeCount: this.activeRequests.size,
        graceMs: this.config.shutdownGraceMs,
      });

      const allDone = Promise.all(Array.from(this.activeRequests).map((r) => r.donePromise));
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.config.shutdownGraceMs);
      });

      const outcome = await Promise.race([allDone, timeoutPromise]);
      if (timer) clearTimeout(timer);

      if (outcome === "timeout" && this.activeRequests.size > 0) {
        this.logger.warn("Shutdown grace period exceeded; aborting remaining turns", {
          abortedCount: this.activeRequests.size,
        });
        for (const reqRecord of this.activeRequests) {
          reqRecord.abortController.abort();
        }
        // Small pause to allow abort notifications to flush
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // 3. Close open connections to unblock server.close()
    if (typeof this.server.closeAllConnections === "function") {
      this.server.closeAllConnections();
    }

    if (serverClosePromise) {
      await serverClosePromise;
    }

    // 4. Close ResponseRegistry
    await this.responseRegistry.close();

    // 5. Close ProfileManager and all profile runtimes
    await this.profileManager.closeAll();
    this.logger.info("RefinedOpenAiServer shutdown complete");
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestId = generateRequestId();
    const startTimeMs = Date.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;
    const abortController = new AbortController();

    this.metrics.recordRequestStart(pathname);
    let recordedEnd = false;

    let markDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      markDone = resolve;
    });

    const activeRecord: ActiveRequestRecord = {
      abortController,
      donePromise,
      markDone,
    };
    this.activeRequests.add(activeRecord);

    const cleanup = () => {
      this.activeRequests.delete(activeRecord);
      markDone();
      if (!recordedEnd) {
        recordedEnd = true;
        const latencyMs = Date.now() - startTimeMs;
        this.metrics.recordRequestEnd(pathname, res.statusCode, latencyMs);
      }
    };

    res.on("finish", () => {
      cleanup();
      const latencyMs = Date.now() - startTimeMs;
      this.logger.info("HTTP request completed", {
        requestId,
        method: req.method,
        path: pathname,
        statusCode: res.statusCode,
        latencyMs,
      });
    });

    res.on("close", () => {
      cleanup();
    });

    const context: RequestContext = {
      requestId,
      req,
      res,
      url,
      pathname,
      startTimeMs,
      profileManager: this.profileManager,
      modelCatalog: this.modelCatalog,
      responseRegistry: this.responseRegistry,
      metrics: this.metrics,
      config: this.config,
      logger: this.logger,
      isDraining: this.isDraining,
    };

    this.dispatchRoute(context, abortController).catch((err) => {
      this.logger.error("Unhandled error during request processing", err, {
        requestId,
        path: pathname,
      });
      sendError(res, err, requestId);
    });
  }

  private async dispatchRoute(context: RequestContext, abortController: AbortController): Promise<void> {
    const { pathname, req, res, requestId } = context;

    // 1. Health / Liveness endpoint (no auth required)
    if (pathname === "/healthz") {
      handleHealth(context);
      return;
    }

    // 1b. Readiness endpoint (no auth required)
    if (pathname === "/readyz") {
      handleReady(context);
      return;
    }

    // 1c. Protected operational status report (requires Bearer auth)
    if (pathname === "/status") {
      handleStatus(context);
      return;
    }

    // 2. Chat Completions: POST /v1/chat/completions
    if (pathname === "/v1/chat/completions") {
      await handleChatCompletions(context, abortController);
      return;
    }

    // 3. Responses: POST /v1/responses
    if (pathname === "/v1/responses") {
      await handleResponses(context, abortController);
      return;
    }

    // 4. Retrieve Response: GET /v1/responses/:response_id
    if (pathname.startsWith("/v1/responses/")) {
      const responseId = decodeURIComponent(pathname.slice("/v1/responses/".length));
      if (!responseId) {
        sendError(res, routeNotFoundError(req.method ?? "UNKNOWN", pathname), requestId);
        return;
      }
      await handleGetResponse(context, responseId);
      return;
    }

    // 5. Models list: GET /v1/models
    if (pathname === "/v1/models") {
      await handleModels(context);
      return;
    }

    // 6. Single model: GET /v1/models/:model
    if (pathname.startsWith("/v1/models/")) {
      const modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
      if (!modelId) {
        sendError(res, routeNotFoundError(req.method ?? "UNKNOWN", pathname), requestId);
        return;
      }
      await handleModels(context, modelId);
      return;
    }

    // 7. Fallback: 404 Route Not Found
    sendError(res, routeNotFoundError(req.method ?? "UNKNOWN", pathname), requestId);
  }
}


export function createServer(options: CreateServerOptions): RefinedOpenAiServer {
  return new RefinedOpenAiServer(options);
}

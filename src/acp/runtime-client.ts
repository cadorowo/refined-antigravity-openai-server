import {
  createRuntimeConnector,
  type AcpStreamMessage,
} from "../upstream/refined-antigravity.js";
import {
  AcpRequestError,
  AcpRuntimeError,
  AcpTimeoutError,
  ConcurrentTurnError,
  RuntimeClosedError,
  RuntimeNotStartedError,
} from "./errors.js";
import {
  createPermissionHandler,
  type PermissionHandler,
  type PermissionPolicy,
  type PermissionRequest,
} from "./permission-handler.js";
import {
  AsyncQueue,
  normalizeUsage,
  type AcpConnectorFn,
  type ClientCapabilities,
  type ClientInfo,
  type InitializeResult,
  type JsonRpcId,
  type NewSessionOptions,
  type NormalizedUsage,
  type PromptContentItem,
  type PromptInput,
  type PromptOptions,
  type PromptResult,
  type PromptTurn,
  type PromptUsage,
  type RuntimeLogger,
  type SessionConfigOption,
  type SessionMode,
  type SessionModel,
  type SessionState,
  type SessionUpdate,
} from "./runtime-types.js";

export class NoopLogger implements RuntimeLogger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
}

export interface AcpRuntimeClientOptions {
  connector?: AcpConnectorFn | undefined;
  permissionHandler?: PermissionHandler | PermissionPolicy | undefined;
  clientCapabilities?: ClientCapabilities | undefined;
  clientInfo?: ClientInfo | undefined;
  logger?: RuntimeLogger | undefined;
  usageResolver?: ((sessionId: string) => PromptUsage | null | undefined) | undefined;
}

interface PendingRequestEntry {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout | undefined;
}

interface ActiveTurnState {
  sessionId: string;
  queue: AsyncQueue<SessionUpdate>;
  abortController?: AbortController | undefined;
  latestUsageUpdate?: PromptUsage | undefined;
}

function isRpcResponse(
  message: AcpStreamMessage,
): message is AcpStreamMessage & { id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } } {
  return (
    "id" in message &&
    message.id !== null &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    ("result" in message || "error" in message)
  );
}

function isRpcRequest(
  message: AcpStreamMessage,
): message is AcpStreamMessage & { id: JsonRpcId; method: string; params?: unknown } {
  return (
    "id" in message &&
    message.id !== null &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    "method" in message &&
    typeof message.method === "string"
  );
}

function isRpcNotification(
  message: AcpStreamMessage,
): message is AcpStreamMessage & { method: string; params?: unknown } {
  return !("id" in message) && "method" in message && typeof message.method === "string";
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * AcpRuntimeClient wraps the low-level ACP stream connector into a high-level,
 * multi-instance-safe TypeScript API.
 */
export class AcpRuntimeClient {
  private readonly connector: AcpConnectorFn;
  private readonly permissionHandler: PermissionHandler;
  private readonly clientCapabilities: ClientCapabilities;
  private readonly clientInfo: ClientInfo;
  private readonly logger: RuntimeLogger;

  private reader: ReadableStreamDefaultReader<AcpStreamMessage> | null = null;
  private writer: WritableStreamDefaultWriter<AcpStreamMessage> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  private startPromise: Promise<void> | null = null;
  private started = false;
  private closed = false;

  private nextRequestId = 1;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequestEntry>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly observedUnknownMethods: string[] = [];
  private readonly usageResolver?: ((sessionId: string) => PromptUsage | null | undefined) | undefined;

  private activeTurn: ActiveTurnState | null = null;
  private initResult: InitializeResult | null = null;

  constructor(options: AcpRuntimeClientOptions = {}) {
    this.connector = options.connector ?? createRuntimeConnector();
    this.permissionHandler = createPermissionHandler(options.permissionHandler ?? "reject");
    this.clientCapabilities = options.clientCapabilities ?? {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    };
    this.clientInfo = options.clientInfo ?? {
      name: "refined-antigravity-openai-server",
      version: "0.1.0",
    };
    this.logger = options.logger ?? new NoopLogger();
    this.usageResolver = options.usageResolver;
  }

  public get isStarted(): boolean {
    return this.started;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get unknownMethods(): readonly string[] {
    return [...this.observedUnknownMethods];
  }

  public get initializeResult(): InitializeResult | null {
    return this.initResult;
  }

  public getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Starts the runtime client in a single-flight manner.
   * If already started, this is a no-op.
   * Concurrent calls share the same initialization promise.
   */
  public async start(): Promise<void> {
    if (this.closed) {
      throw new RuntimeClosedError("Cannot start a closed AcpRuntimeClient");
    }
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      try {
        this.logger.debug("Connecting to ACP stream...");
        const stream = await this.connector();
        this.writer = stream.writable.getWriter();
        this.reader = stream.readable.getReader();

        // Start centralized reader loop
        this.readLoopPromise = this.runCentralReaderLoop();

        this.logger.debug("Sending ACP initialize request...");
        const initResponse = await this.sendRequestInternal<InitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: this.clientCapabilities,
          clientInfo: this.clientInfo,
        });

        this.initResult = initResponse;
        this.started = true;
        this.logger.info("AcpRuntimeClient successfully initialized", {
          protocolVersion: initResponse.protocolVersion,
        });
      } catch (error) {
        await this.internalTeardown();
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  /**
   * Creates a new ACP session.
   */
  public async newSession(options: NewSessionOptions): Promise<SessionState> {
    this.ensureActive();

    const response = await this.request<Record<string, unknown>>("session/new", {
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    });

    const sessionId = response["sessionId"];
    if (typeof sessionId !== "string" || !sessionId) {
      throw new AcpRuntimeError(`session/new returned invalid sessionId: ${JSON.stringify(response)}`);
    }

    const modesRaw = response["modes"];
    let modes: { currentModeId?: string | undefined; availableModes: SessionMode[] } | undefined;
    if (typeof modesRaw === "object" && modesRaw !== null) {
      const currentModeId = (modesRaw as { currentModeId?: unknown }).currentModeId;
      const availableModesRaw = (modesRaw as { availableModes?: unknown }).availableModes;
      const availableModes: SessionMode[] = Array.isArray(availableModesRaw)
        ? (availableModesRaw as SessionMode[])
        : [];
      modes = {
        currentModeId: typeof currentModeId === "string" ? currentModeId : undefined,
        availableModes,
      };
    }

    const configOptionsRaw = response["configOptions"];
    const configOptions: SessionConfigOption[] | undefined = Array.isArray(configOptionsRaw)
      ? (configOptionsRaw as SessionConfigOption[])
      : undefined;

    const modelsRaw = response["models"];
    let models: { currentModelId?: string | undefined; availableModels: SessionModel[] } | undefined;
    if (typeof modelsRaw === "object" && modelsRaw !== null) {
      const currentModelId = (modelsRaw as { currentModelId?: unknown }).currentModelId;
      const availableModelsRaw = (modelsRaw as { availableModels?: unknown }).availableModels;
      const availableModels: SessionModel[] = Array.isArray(availableModelsRaw)
        ? (availableModelsRaw as SessionModel[])
        : [];
      models = {
        currentModelId: typeof currentModelId === "string" ? currentModelId : undefined,
        availableModels,
      };
    }

    const state: SessionState = {
      sessionId,
      cwd: options.cwd,
      modes,
      configOptions,
      models,
      rawResult: response,
    };

    this.sessions.set(sessionId, state);
    return state;
  }

  /**
   * Switches the active mode for a session (e.g. "default", "auto_edit", "yolo").
   */
  public async setMode(sessionId: string, modeId: string): Promise<void> {
    this.ensureActive();
    await this.request("session/set_mode", { sessionId, modeId });
    const session = this.sessions.get(sessionId);
    if (session && session.modes) {
      session.modes.currentModeId = modeId;
    }
  }

  /**
   * Sets a configuration option for a session (e.g. model, thought_level / reasoning_effort).
   */
  public async setConfigOption(sessionId: string, configId: string, value: unknown): Promise<void> {
    this.ensureActive();
    await this.request("session/set_config_option", { sessionId, configId, value });
    const session = this.sessions.get(sessionId);
    if (session && session.configOptions) {
      const option = session.configOptions.find((opt) => opt.id === configId);
      if (option) {
        option.currentValue = value;
      }
    }
  }

  /**
   * Sends a prompt to the ACP agent.
   * Enforces 1 active foreground prompt per AcpRuntimeClient instance.
   */
  public prompt(
    sessionId: string,
    prompt: PromptInput,
    options: PromptOptions = {},
  ): PromptTurn {
    this.ensureActive();

    if (this.activeTurn !== null) {
      throw new ConcurrentTurnError(
        `Cannot start prompt for session '${sessionId}': a foreground prompt is already active on this AcpRuntimeClient (active session: '${this.activeTurn.sessionId}')`,
      );
    }

    const formattedPrompt: PromptContentItem[] =
      typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;

    const queue = new AsyncQueue<SessionUpdate>();
    const signal = options.signal;

    if (signal?.aborted) {
      queue.fail(new AcpRuntimeError("Prompt was aborted before dispatch"));
      const rejectedResult = Promise.reject(new AcpRuntimeError("Prompt was aborted before dispatch"));
      // Attach noop catch to avoid unhandled rejection if caller hasn't attached listener yet
      rejectedResult.catch(() => {});
      return {
        sessionId,
        updates: queue,
        result: rejectedResult,
      };
    }

    const turnState: ActiveTurnState = {
      sessionId,
      queue,
    };
    this.activeTurn = turnState;

    let abortListener: (() => void) | undefined;
    if (signal) {
      abortListener = () => {
        this.logger.info("AbortSignal triggered, sending session/cancel", { sessionId });
        this.sendNotification("session/cancel", { sessionId }).catch((err) => {
          this.logger.warn("Failed to dispatch session/cancel notification", {
            sessionId,
            error: formatErrorMessage(err),
          });
        });
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    const resultPromise = (async (): Promise<PromptResult> => {
      try {
        const rawResult = await this.sendRequestInternal<Record<string, unknown>>(
          "session/prompt",
          {
            sessionId,
            prompt: formattedPrompt,
          },
          options.timeoutMs,
        );

        const stopReason = typeof rawResult["stopReason"] === "string" ? rawResult["stopReason"] : "end_turn";
        const rawUsage =
          typeof rawResult["usage"] === "object" && rawResult["usage"] !== null
            ? (rawResult["usage"] as PromptUsage)
            : undefined;

        let resolvedUsage: PromptUsage | undefined = rawUsage;

        // Fallback 1: Resolve usage via custom usageResolver (e.g. SQLite database for isolated profiles)
        if (!resolvedUsage && this.usageResolver) {
          try {
            const fromResolver = this.usageResolver(sessionId);
            if (fromResolver) {
              resolvedUsage = fromResolver;
            }
          } catch (resolverErr) {
            this.logger.warn("Usage resolver threw an error", {
              sessionId,
              error: formatErrorMessage(resolverErr),
            });
          }
        }

        // Fallback 2: Cumulative usage_update notifications received during turn
        if (!resolvedUsage && turnState.latestUsageUpdate) {
          resolvedUsage = turnState.latestUsageUpdate;
        }

        const usage = normalizeUsage(resolvedUsage);

        queue.end();
        return {
          stopReason,
          usage,
          raw: rawResult,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        queue.fail(err);
        throw err;
      } finally {
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
        if (this.activeTurn?.sessionId === sessionId) {
          this.activeTurn = null;
        }
      }
    })();

    return {
      sessionId,
      updates: queue,
      result: resultPromise,
    };
  }

  /**
   * Explicitly cancels the active turn for a session.
   */
  public async cancel(sessionId: string): Promise<void> {
    this.ensureActive();
    await this.sendNotification("session/cancel", { sessionId });
  }

  /**
   * Sends an arbitrary JSON-RPC request and correlates the response.
   */
  public async request<T = unknown>(
    method: string,
    params: unknown,
    options?: { timeoutMs?: number | undefined },
  ): Promise<T> {
    this.ensureActive();
    return this.sendRequestInternal<T>(method, params, options?.timeoutMs);
  }

  /**
   * Sends a JSON-RPC notification (no response expected).
   */
  public async sendNotification(method: string, params: unknown): Promise<void> {
    if (this.closed) {
      throw new RuntimeClosedError("Cannot send notification: AcpRuntimeClient is closed");
    }
    await this.sendSerializedMessage({
      jsonrpc: "2.0",
      method,
      params,
    } as AcpStreamMessage);
  }

  /**
   * Closes the runtime client, cancels any active turn, rejects pending requests,
   * and cleanly releases streams.
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.logger.info("Closing AcpRuntimeClient...");

    // 1. Best-effort cancellation of active turn
    if (this.activeTurn) {
      const activeSessionId = this.activeTurn.sessionId;
      const turnQueue = this.activeTurn.queue;
      this.activeTurn = null;
      try {
        await Promise.race([
          this.sendSerializedMessage({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId: activeSessionId },
          } as AcpStreamMessage),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Cancel timeout")), 200)),
        ]);
      } catch {
        // Ignore best-effort cancellation failures during close
      }
      turnQueue.fail(new RuntimeClosedError("AcpRuntimeClient is closing"));
    }

    // 2. Reject all pending requests
    this.rejectAllPending(new RuntimeClosedError("AcpRuntimeClient closed with in-flight requests"));

    // 3. Close streams
    await this.internalTeardown();
    this.logger.info("AcpRuntimeClient closed cleanly");
  }

  private ensureActive(): void {
    if (this.closed) {
      throw new RuntimeClosedError();
    }
    if (!this.started) {
      throw new RuntimeNotStartedError();
    }
  }

  private async sendRequestInternal<T>(
    method: string,
    params: unknown,
    timeoutMs?: number | undefined,
  ): Promise<T> {
    const id = this.nextRequestId++;
    let timer: NodeJS.Timeout | undefined;

    const promise = new Promise<T>((resolve, reject) => {
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new AcpTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }

      this.pendingRequests.set(id, {
        method,
        resolve: (val) => {
          if (timer) clearTimeout(timer);
          resolve(val as T);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
        timer,
      });
    });

    try {
      await this.sendSerializedMessage({
        jsonrpc: "2.0",
        id,
        method,
        params,
      } as AcpStreamMessage);
    } catch (error) {
      if (timer) clearTimeout(timer);
      this.pendingRequests.delete(id);
      throw error;
    }

    return promise;
  }

  private async sendSerializedMessage(message: AcpStreamMessage): Promise<void> {
    if (!this.writer) {
      throw new RuntimeClosedError("Cannot send message: stream writer is not available");
    }
    const write = this.writeChain.then(() => this.writer!.write(message));
    this.writeChain = write.catch(() => {});
    await write;
  }

  private async runCentralReaderLoop(): Promise<void> {
    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done || this.closed) break;
        if (!value) continue;

        await this.handleIncomingMessage(value);
      }

      if (!this.closed) {
        const closeError = new AcpRuntimeError("ACP stream closed unexpectedly");
        if (this.activeTurn) {
          const turn = this.activeTurn;
          this.activeTurn = null;
          turn.queue.fail(closeError);
        }
        this.rejectAllPending(closeError);
      }
    } catch (error) {
      if (!this.closed) {
        this.logger.error("Central reader loop caught unhandled error", error);
        const loopError = new AcpRuntimeError(`Central reader loop failed: ${formatErrorMessage(error)}`);
        if (this.activeTurn) {
          const turn = this.activeTurn;
          this.activeTurn = null;
          turn.queue.fail(loopError);
        }
        this.rejectAllPending(loopError);
      }
    }
  }

  private async handleIncomingMessage(message: AcpStreamMessage): Promise<void> {
    // 1. JSON-RPC Response (matches pending request)
    if (isRpcResponse(message)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        this.logger.debug("Received unmatched or duplicate JSON-RPC response", { id: message.id });
        return;
      }

      this.pendingRequests.delete(message.id);
      if ("error" in message && message.error) {
        pending.reject(
          new AcpRequestError(
            message.error.message,
            message.error.code,
            message.error.data,
          ),
        );
      } else if ("result" in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new AcpRuntimeError(`Malformed JSON-RPC response for id: ${String(message.id)}`));
      }
      return;
    }

    // 2. JSON-RPC Request from Agent to Client
    if (isRpcRequest(message)) {
      if (message.method === "session/request_permission") {
        try {
          const decision = await this.permissionHandler.decide(
            (message.params ?? {}) as PermissionRequest,
          );
          await this.sendSerializedMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: decision,
          } as AcpStreamMessage);
        } catch (error) {
          this.logger.error("Permission handler threw an error", error, {
            id: message.id,
          });
          await this.sendSerializedMessage({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message: `Permission decision failed: ${formatErrorMessage(error)}`,
            },
          } as AcpStreamMessage);
        }
        return;
      }

      // Unknown Agent->Client RPC method
      this.logger.warn("Received unknown agent->client RPC method", {
        method: message.method,
        id: message.id,
      });
      if (!this.observedUnknownMethods.includes(message.method)) {
        this.observedUnknownMethods.push(message.method);
      }

      await this.sendSerializedMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Method not found: ${message.method}`,
        },
      } as AcpStreamMessage);
      return;
    }

    // 3. JSON-RPC Notification (e.g. session/update)
    if (isRpcNotification(message)) {
      if (message.method === "session/update") {
        const params = (message.params ?? {}) as Record<string, unknown>;
        const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
        const updatePayload =
          typeof params["update"] === "object" && params["update"] !== null
            ? (params["update"] as Record<string, unknown>)
            : {};
        const sessionUpdateKind =
          typeof updatePayload["sessionUpdate"] === "string"
            ? updatePayload["sessionUpdate"]
            : "unknown";

        if (sessionId && this.activeTurn && this.activeTurn.sessionId === sessionId) {
          if (sessionUpdateKind === "usage_update") {
            const used = typeof updatePayload["used"] === "number" ? updatePayload["used"] : undefined;
            const size = typeof updatePayload["size"] === "number" ? updatePayload["size"] : undefined;
            if (used !== undefined) {
              this.activeTurn.latestUsageUpdate = {
                totalTokens: used,
                contextWindowUsedTokens: used,
                contextWindowMaxTokens: size,
              };
            }
          }

          this.activeTurn.queue.push({
            sessionId,
            sessionUpdate: sessionUpdateKind,
            update: updatePayload,
            receivedAt: new Date().toISOString(),
          });
        } else {
          this.logger.debug("Received session/update for inactive or non-matching session", {
            sessionId,
            kind: sessionUpdateKind,
          });
        }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pendingRequests) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async internalTeardown(): Promise<void> {
    const writer = this.writer;
    const reader = this.reader;
    this.writer = null;
    this.reader = null;
    this.started = false;

    if (writer) {
      try {
        await Promise.race([
          writer.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Writer close timeout")), 200)),
        ]);
      } catch {
        try {
          await writer.abort();
        } catch {
          // Ignore writer abort errors
        }
      }
    }

    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // Ignore reader cancel errors
      }
    }

    if (this.readLoopPromise) {
      await Promise.race([
        this.readLoopPromise,
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]).catch(() => {});
      this.readLoopPromise = null;
    }
  }
}

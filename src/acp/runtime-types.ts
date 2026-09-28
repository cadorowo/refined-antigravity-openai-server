import type { AcpStreamMessage } from "../upstream/refined-antigravity.js";

export type JsonRpcId = string | number;

export interface JsonRpcRequestPayload<TMethod extends string = string, TParams = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: TMethod;
  params?: TParams | undefined;
}

export interface JsonRpcNotificationPayload<TMethod extends string = string, TParams = unknown> {
  jsonrpc: "2.0";
  method: TMethod;
  params?: TParams | undefined;
}

export interface JsonRpcSuccessPayload<TResult = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorObjectPayload {
  code: number;
  message: string;
  data?: unknown | undefined;
}

export interface JsonRpcErrorPayload {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObjectPayload;
}

export type AcpWireMessage =
  | JsonRpcRequestPayload
  | JsonRpcNotificationPayload
  | JsonRpcSuccessPayload
  | JsonRpcErrorPayload;

export interface AcpStreamPair {
  readable: ReadableStream<AcpStreamMessage>;
  writable: WritableStream<AcpStreamMessage>;
}

export type AcpConnectorFn = () => Promise<AcpStreamPair> | AcpStreamPair;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogger {
  debug(message: string, context?: Record<string, unknown> | undefined): void;
  info(message: string, context?: Record<string, unknown> | undefined): void;
  warn(message: string, context?: Record<string, unknown> | undefined): void;
  error(message: string, error?: unknown | undefined, context?: Record<string, unknown> | undefined): void;
}

export interface ClientFsCapabilities {
  readTextFile?: boolean | undefined;
  writeTextFile?: boolean | undefined;
  [key: string]: unknown;
}

export interface ClientCapabilities {
  fs?: ClientFsCapabilities | undefined;
  terminal?: boolean | undefined;
  [key: string]: unknown;
}

export interface ClientInfo {
  name: string;
  version?: string | undefined;
  [key: string]: unknown;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown> | undefined;
  authMethods?: unknown[] | undefined;
  agentInfo?: {
    name?: string | undefined;
    title?: string | undefined;
    version?: string | undefined;
    [key: string]: unknown;
  } | undefined;
  [key: string]: unknown;
}

export interface NewSessionOptions {
  cwd: string;
  mcpServers?: unknown[] | undefined;
  [key: string]: unknown;
}

export interface SessionMode {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  [key: string]: unknown;
}

export interface SessionConfigOptionChoice {
  value: unknown;
  name?: string | undefined;
  [key: string]: unknown;
}

export interface SessionConfigOption {
  id: string;
  name?: string | undefined;
  category?: string | undefined;
  type?: string | undefined;
  currentValue?: unknown | undefined;
  options?: SessionConfigOptionChoice[] | undefined;
  [key: string]: unknown;
}

export interface SessionModel {
  modelId: string;
  name?: string | undefined;
  [key: string]: unknown;
}

export interface SessionState {
  sessionId: string;
  cwd?: string | undefined;
  modes?: {
    currentModeId?: string | undefined;
    availableModes: SessionMode[];
  } | undefined;
  configOptions?: SessionConfigOption[] | undefined;
  models?: {
    currentModelId?: string | undefined;
    availableModels: SessionModel[];
  } | undefined;
  rawResult?: unknown | undefined;
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export type PromptContentItem =
  | TextContentBlock
  | { type: string; [key: string]: unknown };

export type PromptInput = string | PromptContentItem[];

export interface PromptOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface PromptUsage {
  totalTokens?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  contextWindowMaxTokens?: number | undefined;
  contextWindowUsedTokens?: number | undefined;
  [key: string]: unknown;
}

export interface NormalizedUsage {
  totalTokens?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  contextWindowMaxTokens?: number | undefined;
  contextWindowUsedTokens?: number | undefined;
}

export function normalizeUsage(raw?: PromptUsage | null): PromptUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const input =
    typeof raw.inputTokens === "number" && Number.isFinite(raw.inputTokens) && raw.inputTokens >= 0
      ? raw.inputTokens
      : undefined;
  const output =
    typeof raw.outputTokens === "number" && Number.isFinite(raw.outputTokens) && raw.outputTokens >= 0
      ? raw.outputTokens
      : undefined;
  let total =
    typeof raw.totalTokens === "number" && Number.isFinite(raw.totalTokens) && raw.totalTokens >= 0
      ? raw.totalTokens
      : undefined;

  if (total === undefined && input !== undefined && output !== undefined) {
    total = input + output;
  }

  if (input === undefined && output === undefined && total === undefined) {
    return undefined;
  }

  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(typeof raw.contextWindowMaxTokens === "number" &&
    Number.isFinite(raw.contextWindowMaxTokens) &&
    raw.contextWindowMaxTokens >= 0
      ? { contextWindowMaxTokens: raw.contextWindowMaxTokens }
      : {}),
    ...(typeof raw.contextWindowUsedTokens === "number" &&
    Number.isFinite(raw.contextWindowUsedTokens) &&
    raw.contextWindowUsedTokens >= 0
      ? { contextWindowUsedTokens: raw.contextWindowUsedTokens }
      : {}),
  };
}

export interface PromptResult {
  stopReason: string;
  usage?: PromptUsage | undefined;
  raw?: unknown | undefined;
}

export interface SessionUpdate {
  sessionId: string;
  sessionUpdate: string;
  update: Record<string, unknown>;
  receivedAt: string;
}

export interface PromptTurn {
  readonly sessionId: string;
  readonly updates: AsyncIterable<SessionUpdate>;
  readonly result: Promise<PromptResult>;
}

/**
 * Async FIFO queue with support for async iteration, cancellation, and error propagation.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private rejecters: Array<(error: unknown) => void> = [];
  private isDone = false;
  private error: unknown = null;

  public push(item: T): void {
    if (this.isDone || this.error) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      this.rejecters.shift();
      resolver({ done: false, value: item });
    } else {
      this.buffer.push(item);
    }
  }

  public end(): void {
    if (this.isDone || this.error) return;
    this.isDone = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      this.rejecters.shift();
      if (resolver) {
        resolver({ done: true, value: undefined });
      }
    }
  }

  public fail(err: unknown): void {
    if (this.isDone || this.error) return;
    this.error = err;
    while (this.rejecters.length > 0) {
      const rejecter = this.rejecters.shift();
      this.resolvers.shift();
      if (rejecter) {
        rejecter(err);
      }
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          const value = this.buffer.shift()!;
          return Promise.resolve({ done: false, value });
        }
        if (this.error) {
          return Promise.reject(this.error);
        }
        if (this.isDone) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push(resolve);
          this.rejecters.push(reject);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.isDone = true;
        this.buffer = [];
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

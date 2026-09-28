/**
 * Custom error hierarchy for the ACP runtime.
 */

export class AcpRuntimeError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = "ACP_RUNTIME_ERROR") {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class RuntimeClosedError extends AcpRuntimeError {
  constructor(message: string = "AcpRuntimeClient is closed") {
    super(message, "RUNTIME_CLOSED");
  }
}

export class RuntimeNotStartedError extends AcpRuntimeError {
  constructor(message: string = "AcpRuntimeClient has not been started") {
    super(message, "RUNTIME_NOT_STARTED");
  }
}

export class ConcurrentTurnError extends AcpRuntimeError {
  constructor(message: string = "A foreground turn is already active on this AcpRuntimeClient") {
    super(message, "CONCURRENT_TURN");
  }
}

export class AcpRequestError extends AcpRuntimeError {
  public readonly rpcCode: number;
  public readonly rpcData?: unknown;

  constructor(message: string, rpcCode: number, rpcData?: unknown) {
    super(message, "ACP_REQUEST_ERROR");
    this.rpcCode = rpcCode;
    if (rpcData !== undefined) {
      this.rpcData = rpcData;
    }
  }
}

export class AcpTimeoutError extends AcpRuntimeError {
  public readonly method: string;
  public readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`ACP request timed out for method '${method}' after ${timeoutMs}ms`, "ACP_TIMEOUT");
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class UnsupportedClientMethodError extends AcpRuntimeError {
  public readonly method: string;

  constructor(method: string) {
    super(`Client method '${method}' is not supported`, "UNSUPPORTED_CLIENT_METHOD");
    this.method = method;
  }
}

export class PermissionDecisionError extends AcpRuntimeError {
  constructor(message: string) {
    super(message, "PERMISSION_DECISION_ERROR");
  }
}

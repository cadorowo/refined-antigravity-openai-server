export interface ServerLogger {
  debug(message: string, context?: Record<string, unknown> | undefined): void;
  info(message: string, context?: Record<string, unknown> | undefined): void;
  warn(message: string, context?: Record<string, unknown> | undefined): void;
  error(message: string, error?: unknown | undefined, context?: Record<string, unknown> | undefined): void;
}

const SENSITIVE_KEY_PATTERN = /^(authorization|api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret|cookie|cookies|credentials|prompt|instructions)$/i;

const SENSITIVE_STRING_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Bearer\s+([A-Za-z0-9_\-.~+/=]+)/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /sk-[A-Za-z0-9_\-]{8,}/gi, replacement: "sk-[REDACTED]" },
  { pattern: /acp_token\.json/gi, replacement: "[REDACTED_TOKEN_FILE]" },
  { pattern: /(?:\/|[A-Za-z]:\\)[^\s"']*(?:gemini|profiles)[^\s"']*(?:oauth|credentials|acp_token)[^\s"']*/gi, replacement: "[REDACTED_PATH]" },
];

export function sanitizeLogString(str: string): string {
  let result = str;
  for (const { pattern, replacement } of SENSITIVE_STRING_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function sanitizeLogContext(data: unknown, depth: number = 0): unknown {
  if (depth > 8) {
    return "[MAX_DEPTH]";
  }

  if (typeof data === "string") {
    return sanitizeLogString(data);
  }

  if (typeof data !== "object" || data === null) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogContext(item, depth + 1));
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: sanitizeLogString(data.message),
      ...(data.stack ? { stack: sanitizeLogString(data.stack) } : {}),
    };
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeLogContext(value, depth + 1);
    }
  }

  return sanitized;
}

export class DefaultServerLogger implements ServerLogger {
  public debug(message: string, context?: Record<string, unknown>): void {
    if (process.env["DEBUG"] || process.env["LOG_LEVEL"] === "debug") {
      const sanitizedContext = context ? sanitizeLogContext(context) : undefined;
      const sanitizedMsg = sanitizeLogString(message);
      console.debug(
        `[DEBUG] ${sanitizedMsg}`,
        sanitizedContext ? JSON.stringify(sanitizedContext) : "",
      );
    }
  }

  public info(message: string, context?: Record<string, unknown>): void {
    if (process.env["NODE_ENV"] !== "test") {
      const sanitizedContext = context ? sanitizeLogContext(context) : undefined;
      const sanitizedMsg = sanitizeLogString(message);
      console.log(
        `[INFO] ${sanitizedMsg}`,
        sanitizedContext ? JSON.stringify(sanitizedContext) : "",
      );
    }
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    if (process.env["NODE_ENV"] !== "test") {
      const sanitizedContext = context ? sanitizeLogContext(context) : undefined;
      const sanitizedMsg = sanitizeLogString(message);
      console.warn(
        `[WARN] ${sanitizedMsg}`,
        sanitizedContext ? JSON.stringify(sanitizedContext) : "",
      );
    }
  }

  public error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    if (process.env["NODE_ENV"] !== "test") {
      const sanitizedContext = context ? sanitizeLogContext(context) : undefined;
      const sanitizedMsg = sanitizeLogString(message);
      const errMsg = error instanceof Error ? sanitizeLogString(error.message) : String(error ?? "");
      console.error(
        `[ERROR] ${sanitizedMsg}`,
        errMsg,
        sanitizedContext ? JSON.stringify(sanitizedContext) : "",
      );
    }
  }
}

export class NoopServerLogger implements ServerLogger {
  public debug(_message: string, _context?: Record<string, unknown>): void {}
  public info(_message: string, _context?: Record<string, unknown>): void {}
  public warn(_message: string, _context?: Record<string, unknown>): void {}
  public error(_message: string, _error?: unknown, _context?: Record<string, unknown>): void {}
}

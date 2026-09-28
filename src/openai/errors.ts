import type { OpenAIErrorResponse } from "./types.js";

export class OpenAIHttpError extends Error {
  public readonly statusCode: number;
  public readonly errorType: string;
  public readonly code: string;
  public readonly param: string | null;

  constructor(
    statusCode: number,
    message: string,
    options: {
      type?: string | undefined;
      code?: string | undefined;
      param?: string | null | undefined;
    } = {},
  ) {
    super(message);
    this.name = "OpenAIHttpError";
    this.statusCode = statusCode;
    this.errorType =
      options.type ??
      (statusCode === 401
        ? "invalid_request_error"
        : statusCode === 429
          ? "requests"
          : statusCode >= 500
            ? "api_error"
            : "invalid_request_error");
    this.code = options.code ?? defaultCodeForStatus(statusCode);
    this.param = options.param ?? null;
  }

  public toPayload(): OpenAIErrorResponse {
    return {
      error: {
        message: this.message,
        type: this.errorType,
        param: this.param,
        code: this.code,
      },
    };
  }
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "invalid_api_key";
    case 403:
      return "permission_denied";
    case 404:
      return "resource_not_found";
    case 405:
      return "method_not_allowed";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limit_exceeded";
    case 503:
      return "service_unavailable";
    default:
      return status >= 500 ? "internal_server_error" : "invalid_request_error";
  }
}

export function createOpenAiErrorPayload(
  message: string,
  statusCode = 500,
  options: {
    type?: string | undefined;
    code?: string | undefined;
    param?: string | null | undefined;
  } = {},
): OpenAIErrorResponse {
  const err = new OpenAIHttpError(statusCode, message, options);
  return err.toPayload();
}

export function invalidApiKeyError(
  message = "Incorrect API key provided. You can obtain an API key from the server administrator.",
): OpenAIHttpError {
  return new OpenAIHttpError(401, message, {
    type: "invalid_request_error",
    code: "invalid_api_key",
    param: null,
  });
}

export function routeNotFoundError(method: string, path: string): OpenAIHttpError {
  return new OpenAIHttpError(404, `Unknown request URL: ${method} ${path}. Please check the URL and try again.`, {
    type: "invalid_request_error",
    code: "route_not_found",
    param: null,
  });
}

export function modelNotFoundError(modelId: string): OpenAIHttpError {
  return new OpenAIHttpError(404, `The model '${modelId}' does not exist`, {
    type: "invalid_request_error",
    code: "model_not_found",
    param: "model",
  });
}

export function methodNotAllowedError(method: string, path: string, allowedMethods: string[]): OpenAIHttpError {
  return new OpenAIHttpError(
    405,
    `Method ${method} is not allowed on ${path}. Allowed: ${allowedMethods.join(", ")}`,
    {
      type: "invalid_request_error",
      code: "method_not_allowed",
      param: null,
    },
  );
}

export function payloadTooLargeError(maxBytes: number): OpenAIHttpError {
  return new OpenAIHttpError(413, `Request body exceeds maximum allowed size of ${maxBytes} bytes.`, {
    type: "invalid_request_error",
    code: "payload_too_large",
    param: null,
  });
}

export function serviceUnavailableError(
  message = "No Antigravity profile is currently available to serve the request.",
): OpenAIHttpError {
  return new OpenAIHttpError(503, message, {
    type: "api_error",
    code: "service_unavailable",
    param: null,
  });
}

export function internalServerError(message = "An internal server error occurred."): OpenAIHttpError {
  return new OpenAIHttpError(500, message, {
    type: "api_error",
    code: "internal_server_error",
    param: null,
  });
}

export function responseNotFoundError(responseId: string): OpenAIHttpError {
  return new OpenAIHttpError(404, `Response '${responseId}' not found.`, {
    type: "invalid_request_error",
    code: "response_not_found",
    param: "previous_response_id",
  });
}


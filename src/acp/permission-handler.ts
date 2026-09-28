import { PermissionDecisionError } from "./errors.js";

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | string;

export interface PermissionOption {
  optionId: string;
  kind: PermissionOptionKind;
  name?: string | undefined;
  [key: string]: unknown;
}

export interface ToolCallLocation {
  path?: string | undefined;
  [key: string]: unknown;
}

export interface ToolCallContent {
  type?: string | undefined;
  path?: string | undefined;
  newText?: string | undefined;
  oldText?: string | undefined;
  [key: string]: unknown;
}

export interface ToolCallInfo {
  toolCallId?: string | undefined;
  kind?: string | undefined;
  status?: string | undefined;
  title?: string | undefined;
  content?: ToolCallContent[] | undefined;
  locations?: ToolCallLocation[] | undefined;
  rawInput?: unknown | undefined;
  [key: string]: unknown;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall?: ToolCallInfo | undefined;
  options: PermissionOption[];
  [key: string]: unknown;
}

export type PermissionDecisionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface PermissionDecision {
  outcome: PermissionDecisionOutcome;
}

export type PermissionPolicy = "reject" | "allow-once" | "allow-always";

export interface PermissionHandler {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface PolicyPermissionHandlerOptions {
  policy: PermissionPolicy;
  /**
   * If policy is "allow-always" but no "allow_always" option is present in the request,
   * whether to fall back to an available "allow_once" option.
   * Defaults to true.
   */
  fallbackToAllowOnce?: boolean | undefined;
}

/**
 * Standard policy-based PermissionHandler.
 * Selects options based on the `kind` field rather than hardcoded option IDs.
 */
export class PolicyPermissionHandler implements PermissionHandler {
  public readonly policy: PermissionPolicy;
  public readonly fallbackToAllowOnce: boolean;

  constructor(options: PolicyPermissionHandlerOptions | PermissionPolicy) {
    if (typeof options === "string") {
      this.policy = options;
      this.fallbackToAllowOnce = true;
    } else {
      this.policy = options.policy;
      this.fallbackToAllowOnce = options.fallbackToAllowOnce ?? true;
    }
  }

  public async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const options = Array.isArray(request.options) ? request.options : [];

    switch (this.policy) {
      case "reject": {
        const rejectOnce = options.find((opt) => opt.kind === "reject_once");
        if (rejectOnce) {
          return { outcome: { outcome: "selected", optionId: rejectOnce.optionId } };
        }
        const rejectAlways = options.find((opt) => opt.kind === "reject_always");
        if (rejectAlways) {
          return { outcome: { outcome: "selected", optionId: rejectAlways.optionId } };
        }
        // If neither reject option is explicitly provided, return cancelled outcome
        return { outcome: { outcome: "cancelled" } };
      }

      case "allow-once": {
        const allowOnce = options.find((opt) => opt.kind === "allow_once");
        if (allowOnce) {
          return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
        }
        throw new PermissionDecisionError(
          `Permission policy is 'allow-once' but no option with kind 'allow_once' was offered. Available options: ${JSON.stringify(
            options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
          )}`,
        );
      }

      case "allow-always": {
        const allowAlways = options.find((opt) => opt.kind === "allow_always");
        if (allowAlways) {
          return { outcome: { outcome: "selected", optionId: allowAlways.optionId } };
        }
        if (this.fallbackToAllowOnce) {
          const allowOnce = options.find((opt) => opt.kind === "allow_once");
          if (allowOnce) {
            return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
          }
        }
        throw new PermissionDecisionError(
          `Permission policy is 'allow-always' but no option with kind 'allow_always' (or 'allow_once' fallback) was offered. Available options: ${JSON.stringify(
            options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
          )}`,
        );
      }

      default: {
        const exhaustiveCheck: never = this.policy;
        throw new PermissionDecisionError(`Unknown permission policy: ${String(exhaustiveCheck)}`);
      }
    }
  }
}

/**
 * Functional callback-based PermissionHandler.
 */
export class CallbackPermissionHandler implements PermissionHandler {
  constructor(
    private readonly callback: (request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision,
  ) {}

  public async decide(request: PermissionRequest): Promise<PermissionDecision> {
    return this.callback(request);
  }
}

/**
 * Normalize a policy name or custom handler into a PermissionHandler instance.
 */
export function createPermissionHandler(
  handlerOrPolicy: PermissionHandler | PermissionPolicy = "reject",
): PermissionHandler {
  if (typeof handlerOrPolicy === "string") {
    return new PolicyPermissionHandler(handlerOrPolicy);
  }
  return handlerOrPolicy;
}

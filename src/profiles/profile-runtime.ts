import path from "node:path";

import { AcpRuntimeClient } from "../acp/runtime-client.js";
import { PolicyPermissionHandler } from "../acp/permission-handler.js";
import type { SessionState } from "../acp/runtime-types.js";
import { createRuntimeConnector, getProfileSessionUsage } from "../upstream/refined-antigravity.js";
import type {
  ProfileConfig,
  ProfileFailureKind,
  ProfileSnapshot,
  ProfileState,
} from "./types.js";

export interface ProfileRuntimeOptions {
  config: ProfileConfig;
  runtime?: AcpRuntimeClient | undefined;
  runtimeFactory?: (() => AcpRuntimeClient) | undefined;
}

export class ProfileRuntime {
  public static readonly MAX_CONSECUTIVE_RESTARTS = 3;

  public readonly config: ProfileConfig;
  public runtime: AcpRuntimeClient;

  private readonly runtimeFactory: () => AcpRuntimeClient;
  private state: ProfileState;
  private activeLeases = 0;
  private consecutiveRestarts = 0;
  private cooldownUntilMs: number | undefined;
  private lastFailureKind: ProfileFailureKind | undefined;
  private lastErrorMsg: string | undefined;
  private lastSuccessTime: string | undefined;
  private lastFailureTime: string | undefined;
  private restartPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;

  constructor(options: ProfileRuntimeOptions) {
    const raw = options.config;
    const geminiHome = path.resolve(raw.geminiHome);

    this.config = {
      id: raw.id,
      geminiHome,
      priority: raw.priority ?? 100,
      enabled: raw.enabled ?? true,
      sessionMode: raw.sessionMode ?? "yolo",
      ...(raw.env === undefined ? {} : { env: raw.env }),
    };

    this.state = this.config.enabled ? "ready" : "disabled";

    this.runtimeFactory =
      options.runtimeFactory ??
      (() =>
        new AcpRuntimeClient({
          connector: createRuntimeConnector({
            geminiHome,
            env: this.config.env,
          }),
          // Recommended production posture: YOLO mode auto-approves coding actions,
          // while fallback policy rejects unexpected permission requests.
          permissionHandler: new PolicyPermissionHandler("reject"),
          clientInfo: {
            name: `refined-antigravity-openai-server:${this.config.id}`,
            version: "0.2.5",
          },
          usageResolver: (sessionId: string) => {
            const usage = getProfileSessionUsage(sessionId, geminiHome);
            if (!usage) return undefined;
            return {
              totalTokens: usage.usedTokens,
              inputTokens: usage.promptTokens,
              outputTokens: usage.candidateTokens,
              contextWindowMaxTokens: usage.maxTokens,
              contextWindowUsedTokens: usage.usedTokens,
            };
          },
        }));

    this.runtime = options.runtime ?? this.runtimeFactory();
  }

  public get id(): string {
    return this.config.id;
  }

  public get currentState(): ProfileState {
    this.refreshCooldown();
    return this.state;
  }

  public get activeLeaseCount(): number {
    return this.activeLeases;
  }

  public get lastError(): string | undefined {
    return this.lastErrorMsg;
  }

  public get lastSuccessAt(): string | undefined {
    return this.lastSuccessTime;
  }

  public get lastFailureAt(): string | undefined {
    return this.lastFailureTime;
  }

  public get restartAttemptCount(): number {
    return this.consecutiveRestarts;
  }

  public get cooldownUntil(): string | undefined {
    return this.cooldownUntilMs !== undefined
      ? new Date(this.cooldownUntilMs).toISOString()
      : undefined;
  }

  public async start(): Promise<void> {
    if (this.closing) throw new Error(`Cannot start closing profile: ${this.id}`);
    if (!this.config.enabled) {
      this.state = "disabled";
      throw new Error(`Cannot start disabled profile: ${this.id}`);
    }
    await this.runtime.start();
    if (this.closing) throw new Error(`Profile '${this.id}' closed during startup`);
    if (this.state !== "cooldown" && this.state !== "quota_exhausted" && this.state !== "auth_required") {
      this.state = this.activeLeases > 0 ? "busy" : "ready";
    }
  }

  /**
   * Restarts the underlying ACP runtime cleanly, restoring the profile to ready state.
   * Enforces bounded restart attempts; blocks restart on auth_required and quota_exhausted.
   */
  public async restart(): Promise<void> {
    if (this.restartPromise) return this.restartPromise;
    if (this.closing) throw new Error(`Cannot restart closing profile: ${this.id}`);
    if (!this.config.enabled) {
      this.state = "disabled";
      throw new Error(`Cannot restart disabled profile: ${this.id}`);
    }
    if (this.state === "auth_required") {
      throw new Error(`Cannot restart profile '${this.id}' in auth_required state; manual re-authentication required`);
    }
    if (this.state === "quota_exhausted") {
      throw new Error(`Cannot restart profile '${this.id}' in quota_exhausted state`);
    }
    if (this.activeLeases > 0) {
      throw new Error(`Cannot restart profile '${this.id}' while it has an active lease`);
    }

    if (this.consecutiveRestarts >= ProfileRuntime.MAX_CONSECUTIVE_RESTARTS) {
      this.state = "unhealthy";
      throw new Error(
        `Profile '${this.id}' exceeded maximum restart attempts (${ProfileRuntime.MAX_CONSECUTIVE_RESTARTS}); marked unhealthy`,
      );
    }

    this.consecutiveRestarts++;
    this.state = "unhealthy"; // Exclude this profile from new leases during restart.
    this.restartPromise = this.performRestart().finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  public async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.state = "disabled";
    this.closePromise = (async () => {
      if (this.restartPromise) await this.restartPromise.catch(() => {});
      try {
        await this.runtime.close();
      } finally {
        this.state = "disabled";
      }
    })();
    return this.closePromise;
  }

  private async performRestart(): Promise<void> {
    try {
      await this.runtime.close();
    } catch (error) {
      this.state = this.closing ? "disabled" : "unhealthy";
      throw error;
    }

    if (this.closing) throw new Error(`Profile '${this.id}' closed during restart`);

    try {
      this.runtime = this.runtimeFactory();
      await this.runtime.start();
      if (this.closing) throw new Error(`Profile '${this.id}' closed during restart`);
      this.cooldownUntilMs = undefined;
      this.lastFailureKind = undefined;
      this.lastErrorMsg = undefined;
      this.state = "ready";
    } catch (error) {
      await this.runtime.close().catch(() => {});
      this.state = this.closing ? "disabled" : "unhealthy";
      throw error;
    }
  }

  public async createSession(options: { cwd: string; mcpServers?: unknown[] }): Promise<SessionState> {
    const session = await this.runtime.newSession({
      cwd: options.cwd,
      ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
    });

    const targetMode = this.config.sessionMode ?? "yolo";
    const availableModes = session.modes?.availableModes.map((m) => m.id) ?? [];
    if (availableModes.includes(targetMode)) {
      await this.runtime.setMode(session.sessionId, targetMode);
    }

    return session;
  }

  public acquireLease(): void {
    this.refreshCooldown();
    if (this.state !== "ready") {
      throw new Error(`Cannot acquire lease on profile '${this.id}' in state '${this.state}'`);
    }
    this.activeLeases++;
    this.state = "busy";
  }

  public releaseLease(): void {
    if (this.activeLeases > 0) {
      this.activeLeases--;
    }
    this.refreshCooldown();
    if (
      this.activeLeases === 0 &&
      this.state === "busy"
    ) {
      this.state = "ready";
    }
  }

  public markSuccess(): void {
    if (this.closing || this.restartPromise) return;
    this.lastSuccessTime = new Date().toISOString();
    this.lastErrorMsg = undefined;
    this.consecutiveRestarts = 0;
    this.refreshCooldown();
    if (this.state === "unhealthy" || this.state === "cooldown") {
      this.cooldownUntilMs = undefined;
      this.state = this.activeLeases > 0 ? "busy" : "ready";
    }
  }

  public markFailure(
    kind: ProfileFailureKind,
    error: unknown,
    cooldownMs?: number | undefined,
  ): void {
    this.lastFailureTime = new Date().toISOString();
    this.lastFailureKind = kind;
    this.lastErrorMsg = error instanceof Error ? error.message : String(error);
    if (this.closing || this.restartPromise) return;

    switch (kind) {
      case "auth":
        this.state = "auth_required";
        break;
      case "quota_exhausted":
        this.state = "quota_exhausted";
        break;
      case "rate_limit":
        this.cooldownUntilMs = Date.now() + (cooldownMs ?? 60_000);
        this.state = "cooldown";
        break;
      case "transient":
        this.cooldownUntilMs = Date.now() + (cooldownMs ?? 15_000);
        this.state = "cooldown";
        break;
      case "fatal":
      default:
        this.state = "unhealthy";
        break;
    }
  }

  public markReady(): void {
    if (this.closing || this.restartPromise) {
      throw new Error(`Cannot reset profile '${this.id}' while it is closing or restarting`);
    }
    this.cooldownUntilMs = undefined;
    this.lastFailureKind = undefined;
    this.consecutiveRestarts = 0;
    this.state = this.config.enabled ? (this.activeLeases > 0 ? "busy" : "ready") : "disabled";
  }

  public snapshot(): ProfileSnapshot {
    this.refreshCooldown();
    return {
      id: this.config.id,
      geminiHome: this.config.geminiHome,
      priority: this.config.priority ?? 100,
      enabled: this.config.enabled ?? true,
      sessionMode: this.config.sessionMode ?? "yolo",
      state: this.state,
      activeLeases: this.activeLeases,
      ...(this.cooldownUntilMs === undefined
        ? {}
        : { cooldownUntil: new Date(this.cooldownUntilMs).toISOString() }),
      ...(this.lastFailureKind === undefined ? {} : { lastFailureKind: this.lastFailureKind }),
      ...(this.lastErrorMsg === undefined ? {} : { lastError: this.lastErrorMsg }),
      ...(this.lastSuccessTime === undefined ? {} : { lastSuccessAt: this.lastSuccessTime }),
      ...(this.lastFailureTime === undefined ? {} : { lastFailureAt: this.lastFailureTime }),
    };
  }

  private refreshCooldown(): void {
    if (this.state === "cooldown" && this.cooldownUntilMs !== undefined) {
      if (Date.now() >= this.cooldownUntilMs) {
        this.cooldownUntilMs = undefined;
        this.state = this.activeLeases > 0 ? "busy" : "ready";
      }
    }
  }
}

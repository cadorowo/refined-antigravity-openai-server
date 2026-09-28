import type { ProfileSnapshot } from "../profiles/types.js";

export interface LatencyStats {
  count: number;
  avg_ms: number;
  last_ms: number;
  min_ms: number;
  max_ms: number;
}

export interface SanitizedProfileStatus {
  id: string;
  state: string;
  active_leases: number;
  last_failure_kind: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
}

export interface StatusReport {
  status: "ok" | "draining";
  uptime_seconds: number;
  requests: {
    total: number;
    active: number;
    errors: number;
    failovers: number;
    by_route: Record<string, number>;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  completions: {
    chat_completions: number;
    responses: number;
  };
  streams: {
    active: number;
  };
  latency: LatencyStats;
  registry: {
    responses: number;
  };
  memory: {
    rss_bytes: number;
    heap_total_bytes: number;
    heap_used_bytes: number;
    external_bytes: number;
  };
  profiles: SanitizedProfileStatus[];
}

export class RuntimeMetrics {
  public readonly serverStartedAt: number = Date.now();

  private requestsTotal = 0;
  private requestsActive = 0;
  private readonly requestsByRoute = new Map<string, number>();
  private errorsTotal = 0;
  private failoversTotal = 0;

  private inputTokensTotal = 0;
  private outputTokensTotal = 0;

  private chatCompletionsTotal = 0;
  private responsesTotal = 0;
  private activeStreams = 0;

  private latencyCount = 0;
  private latencySum = 0;
  private latencyLast = 0;
  private latencyMin = Infinity;
  private latencyMax = 0;

  public recordRequestStart(route: string): void {
    this.requestsTotal++;
    this.requestsActive++;
    const current = this.requestsByRoute.get(route) ?? 0;
    this.requestsByRoute.set(route, current + 1);
  }

  public recordRequestEnd(
    route: string,
    statusCode: number,
    latencyMs: number,
    inputTokens?: number,
    outputTokens?: number,
    failovers?: number,
  ): void {
    if (this.requestsActive > 0) {
      this.requestsActive--;
    }

    if (statusCode >= 400) {
      this.errorsTotal++;
    }

    if (failovers && failovers > 0) {
      this.failoversTotal += failovers;
    }

    if (inputTokens && inputTokens > 0) {
      this.inputTokensTotal += inputTokens;
    }

    if (outputTokens && outputTokens > 0) {
      this.outputTokensTotal += outputTokens;
    }

    if (statusCode < 400) {
      if (route === "/v1/chat/completions") {
        this.chatCompletionsTotal++;
      } else if (route === "/v1/responses") {
        this.responsesTotal++;
      }
    }

    this.recordLatency(latencyMs);
  }

  public recordStreamStart(): void {
    this.activeStreams++;
  }

  public recordStreamEnd(): void {
    if (this.activeStreams > 0) {
      this.activeStreams--;
    }
  }

  public recordTokens(inputTokens?: number, outputTokens?: number): void {
    if (inputTokens && inputTokens > 0) {
      this.inputTokensTotal += inputTokens;
    }
    if (outputTokens && outputTokens > 0) {
      this.outputTokensTotal += outputTokens;
    }
  }

  public recordFailover(count: number = 1): void {
    this.failoversTotal += count;
  }

  public snapshot(options?: {
    isDraining?: boolean;
    responseRegistryEntries?: number;
    profiles?: ProfileSnapshot[];
  }): StatusReport {
    const mem = process.memoryUsage();
    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - this.serverStartedAt) / 1000));

    const sanitizedProfiles: SanitizedProfileStatus[] = (options?.profiles ?? []).map((p) => ({
      id: p.id,
      state: p.state,
      active_leases: p.activeLeases,
      last_failure_kind: p.lastFailureKind ?? null,
      last_success_at: p.lastSuccessAt ?? null,
      last_failure_at: p.lastFailureAt ?? null,
    }));

    const byRoute: Record<string, number> = {};
    for (const [route, count] of this.requestsByRoute.entries()) {
      byRoute[route] = count;
    }

    return {
      status: options?.isDraining ? "draining" : "ok",
      uptime_seconds: uptimeSeconds,
      requests: {
        total: this.requestsTotal,
        active: this.requestsActive,
        errors: this.errorsTotal,
        failovers: this.failoversTotal,
        by_route: byRoute,
      },
      tokens: {
        input: this.inputTokensTotal,
        output: this.outputTokensTotal,
        total: this.inputTokensTotal + this.outputTokensTotal,
      },
      completions: {
        chat_completions: this.chatCompletionsTotal,
        responses: this.responsesTotal,
      },
      streams: {
        active: this.activeStreams,
      },
      latency: {
        count: this.latencyCount,
        avg_ms: this.latencyCount > 0 ? Math.round((this.latencySum / this.latencyCount) * 100) / 100 : 0,
        last_ms: this.latencyLast,
        min_ms: this.latencyCount > 0 ? this.latencyMin : 0,
        max_ms: this.latencyMax,
      },
      registry: {
        responses: options?.responseRegistryEntries ?? 0,
      },
      memory: {
        rss_bytes: mem.rss,
        heap_total_bytes: mem.heapTotal,
        heap_used_bytes: mem.heapUsed,
        external_bytes: mem.external,
      },
      profiles: sanitizedProfiles,
    };
  }

  private recordLatency(ms: number): void {
    if (ms < 0) return;
    this.latencyCount++;
    this.latencySum += ms;
    this.latencyLast = ms;
    if (ms < this.latencyMin) this.latencyMin = ms;
    if (ms > this.latencyMax) this.latencyMax = ms;
  }
}

import fs from "node:fs/promises";
import type { ResponseObject, ResponseUsage } from "./types.js";

export interface NormalizedConversationMessage {
  role: "user" | "assistant";
  content: string;
  name?: string | undefined;
}

export interface ResponseRecord {
  id: string;
  createdAt: number;
  completedAt?: number | undefined;
  lastAccessedAt: number;
  model: string;
  previousResponseId?: string | null | undefined;
  preferredProfileId?: string | undefined;
  workspace: string;
  transcript: NormalizedConversationMessage[];
  outputText: string;
  usage?: ResponseUsage | undefined;
  status: "completed" | "failed" | "cancelled";
  instructions?: string | null | undefined;
  metadata?: Record<string, string> | null | undefined;
  store: boolean;
}

export interface ResponseRegistryOptions {
  maxEntries?: number | undefined;
  ttlMs?: number | undefined;
  logger?: {
    debug(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  } | undefined;
}

export class ResponseRegistry {
  private readonly records = new Map<string, ResponseRecord>();
  private readonly workspaceRefCounts = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly logger?: {
    debug(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  } | undefined;

  constructor(options: ResponseRegistryOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.ttlMs = options.ttlMs ?? 3_600_000; // 1 hour default
    this.logger = options.logger;
  }

  public get size(): number {
    return this.records.size;
  }

  /**
   * Retrieves a response record by its ID.
   * If the record has expired per TTL, it is evicted and undefined is returned.
   * Upon successful lookup, updates lastAccessedAt.
   */
  public get(id: string): ResponseRecord | undefined {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }

    if (Date.now() - record.lastAccessedAt > this.ttlMs) {
      this.logger?.debug("Response record expired via TTL", { id });
      this.delete(id);
      return undefined;
    }

    record.lastAccessedAt = Date.now();
    return record;
  }

  /**
   * Stores a completed response record.
   * If store is false, the record is not stored in the registry.
   * Evicts expired records and enforces maxEntries bounding.
   */
  public save(record: ResponseRecord): void {
    if (!record.store) {
      this.logger?.debug("Skipping storage for response record where store=false", { id: record.id });
      return;
    }

    // 1. Evict any expired records first
    this.evictExpired();

    // 2. If at capacity, evict the oldest accessed entry
    if (this.records.size >= this.maxEntries && !this.records.has(record.id)) {
      this.evictOldest();
    }

    // 3. Track workspace refcount
    if (record.workspace) {
      const currentCount = this.workspaceRefCounts.get(record.workspace) ?? 0;
      this.workspaceRefCounts.set(record.workspace, currentCount + 1);
    }

    this.records.set(record.id, {
      ...record,
      lastAccessedAt: record.lastAccessedAt > 0 ? record.lastAccessedAt : Date.now(),
    });


    this.logger?.debug("Saved response record in ResponseRegistry", {
      id: record.id,
      totalEntries: this.records.size,
    });
  }

  /**
   * Deletes a response record by ID and releases its workspace reference.
   */
  public delete(id: string): boolean {
    const record = this.records.get(id);
    if (!record) {
      return false;
    }

    this.records.delete(id);
    this.releaseWorkspace(record.workspace);
    return true;
  }

  /**
   * Formats a stored ResponseRecord as an OpenAI-compatible ResponseObject.
   */
  public toResponseObject(record: ResponseRecord): ResponseObject {
    const messageId = `msg_${record.id.replace(/^resp_/, "")}`;
    return {
      id: record.id,
      object: "response",
      created_at: record.createdAt,
      completed_at: record.completedAt ?? record.createdAt,
      status: record.status,
      model: record.model,
      output: [
        {
          id: messageId,
          type: "message",
          status: record.status === "completed" ? "completed" : "incomplete",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: record.outputText,
              annotations: [],
            },
          ],
        },
      ],
      output_text: record.outputText,
      error: record.status === "failed" ? { code: "server_error", message: "Response generation failed" } : null,
      incomplete_details: null,
      instructions: record.instructions ?? null,
      metadata: record.metadata ?? null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      previous_response_id: record.previousResponseId ?? null,
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
    };
  }

  /**
   * Cleans up all stored records and removes any managed workspaces.
   */
  public async close(): Promise<void> {
    const workspacesToClean = Array.from(this.workspaceRefCounts.keys());
    this.records.clear();
    this.workspaceRefCounts.clear();

    for (const ws of workspacesToClean) {
      try {
        await fs.rm(ws, { recursive: true, force: true });
      } catch {
        // Ignore workspace cleanup error on shutdown
      }
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.records.entries()) {
      if (now - record.lastAccessedAt > this.ttlMs) {
        this.records.delete(id);
        this.releaseWorkspace(record.workspace);
      }
    }
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, record] of this.records.entries()) {
      if (record.lastAccessedAt < oldestTime) {
        oldestTime = record.lastAccessedAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.delete(oldestId);
      this.logger?.debug("Evicted oldest response record from registry", { id: oldestId });
    }
  }

  private releaseWorkspace(workspace: string): void {
    if (!workspace) return;
    const current = this.workspaceRefCounts.get(workspace);
    if (current === undefined) return;

    if (current <= 1) {
      this.workspaceRefCounts.delete(workspace);
      fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    } else {
      this.workspaceRefCounts.set(workspace, current - 1);
    }
  }
}

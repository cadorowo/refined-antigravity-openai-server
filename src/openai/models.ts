import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SessionState } from "../acp/runtime-types.js";
import { classifyProfileFailure } from "../profiles/failure-classifier.js";
import type { ProfileManager } from "../profiles/profile-manager.js";
import type { ProfileRuntime } from "../profiles/profile-runtime.js";
import { serviceUnavailableError } from "./errors.js";
import type { OpenAIModel, OpenAIModelList } from "./types.js";

export interface ModelCatalogLogger {
  debug(message: string, context?: Record<string, unknown> | undefined): void;
  info(message: string, context?: Record<string, unknown> | undefined): void;
  warn(message: string, context?: Record<string, unknown> | undefined): void;
  error(message: string, error?: unknown | undefined, context?: Record<string, unknown> | undefined): void;
}

export type ProfileModelDiscoveryFn = (profile: ProfileRuntime) => Promise<string[]>;

export interface ModelCatalogOptions {
  profileManager: ProfileManager;
  logger?: ModelCatalogLogger | undefined;
  cacheTtlMs?: number | undefined;
  discoveryFn?: ProfileModelDiscoveryFn | undefined;
}

export class ModelCatalog {
  private readonly profileManager: ProfileManager;
  private readonly logger: ModelCatalogLogger;
  private readonly cacheTtlMs: number;
  private readonly discoveryFn: ProfileModelDiscoveryFn;

  private cachedModels = new Map<string, OpenAIModel>();
  private modelProfiles = new Map<string, Set<string>>();
  private readonly modelsByProfile = new Map<string, string[]>();
  private nextDiscoveryAt = 0;
  private inFlightDiscovery: Promise<void> | null = null;

  constructor(options: ModelCatalogOptions) {
    this.profileManager = options.profileManager;
    this.logger = options.logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000; // 10 minutes default
    this.discoveryFn = options.discoveryFn ?? defaultProfileDiscovery;
  }

  /**
   * Returns all known models in OpenAI list format.
   * If cache is cold or expired, triggers discovery.
   */
  public async listModels(forceRefresh = false): Promise<OpenAIModelList> {
    await this.ensureFresh(forceRefresh);
    return {
      object: "list",
      data: Array.from(this.cachedModels.values()),
    };
  }

  /**
   * Returns a single model by ID, or undefined if not found.
   */
  public async getModel(modelId: string, forceRefresh = false): Promise<OpenAIModel | undefined> {
    await this.ensureFresh(forceRefresh);
    return this.cachedModels.get(modelId);
  }

  /**
   * Returns list of profile IDs that support the given model ID.
   */
  public getProfilesForModel(modelId: string): string[] {
    const profileSet = this.modelProfiles.get(modelId);
    return profileSet ? Array.from(profileSet) : [];
  }

  /**
   * Explicitly forces a fresh model discovery across healthy profiles.
   */
  public async refresh(): Promise<void> {
    await this.ensureFresh(true);
  }

  private async ensureFresh(force: boolean): Promise<void> {
    const isExpired = Date.now() >= this.nextDiscoveryAt;

    if (force || isExpired) {
      if (this.inFlightDiscovery) {
        await this.inFlightDiscovery;
      } else {
        this.inFlightDiscovery = this.performDiscovery().finally(() => {
          this.inFlightDiscovery = null;
        });
        await this.inFlightDiscovery;
      }
    }
  }

  private async performDiscovery(): Promise<void> {
    const profiles = this.profileManager.list().filter((p) => p.config.enabled);

    if (profiles.length === 0) {
      this.logger.warn("No enabled Antigravity profiles found in ProfileManager");
      if (this.cachedModels.size === 0) {
        throw serviceUnavailableError("No Antigravity profile is configured or enabled");
      }
      return;
    }

    let successfulProfiles = 0;
    let lastError: unknown;
    let incomplete = false;

    // Sort by priority so preferred profiles are queried first
    const sortedProfiles = [...profiles].sort(
      (a, b) => (a.config.priority ?? 100) - (b.config.priority ?? 100),
    );

    for (const profile of sortedProfiles) {
      // Skip profiles currently in terminal unhealthy state if possible, unless all are unhealthy
      const currentState = profile.currentState;
      if (currentState === "disabled" || currentState === "auth_required" || currentState === "quota_exhausted") {
        this.modelsByProfile.delete(profile.id);
        this.logger.debug("Skipping profile during model discovery due to state", {
          profileId: profile.id,
          state: currentState,
        });
        continue;
      }

      if (currentState !== "ready") {
        incomplete = true;
        continue;
      }

      try {
        await this.profileManager.withProfile(
          async (activeProfile) => {
            const modelIds = await this.discoveryFn(activeProfile);
            this.modelsByProfile.set(activeProfile.id, modelIds);
          },
          { eligibleProfileIds: [profile.id] },
        );
        successfulProfiles++;
      } catch (err) {
        incomplete = true;
        lastError = err;
        const classification = classifyProfileFailure(err);
        this.logger.warn("Model discovery attempt failed on profile", {
          profileId: profile.id,
          classification: classification.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const newModels = new Map<string, OpenAIModel>();
    const newProfilesMap = new Map<string, Set<string>>();
    for (const [profileId, modelIds] of this.modelsByProfile) {
      for (const id of modelIds) {
        if (!newModels.has(id)) {
          newModels.set(id, { id, object: "model", created: 0, owned_by: "antigravity" });
        }
        let set = newProfilesMap.get(id);
        if (!set) {
          set = new Set<string>();
          newProfilesMap.set(id, set);
        }
        set.add(profileId);
      }
    }

    this.cachedModels = newModels;
    this.modelProfiles = newProfilesMap;

    if (successfulProfiles === 0) {
      if (newModels.size > 0) {
        this.nextDiscoveryAt = Date.now() + Math.min(this.cacheTtlMs, 1_000);
        this.logger.warn(
          "Model discovery failed across all profiles; retaining previously cached models",
          { error: String(lastError) },
        );
        return;
      }
      throw serviceUnavailableError(
        `Failed to discover models: no available Antigravity profile could be reached (${String(lastError ?? "no profiles responded")})`,
      );
    }

    // A busy profile is retried soon, without rediscovering it on every request.
    this.nextDiscoveryAt = Date.now() + (incomplete ? Math.min(this.cacheTtlMs, 1_000) : this.cacheTtlMs);
    this.logger.info("Model discovery completed successfully", {
      modelsCount: this.cachedModels.size,
      profilesCount: successfulProfiles,
    });
  }
}

/**
 * Default live discovery logic: creates a temporary scratch session on the profile
 * to retrieve available models from session state without executing prompts.
 */
async function defaultProfileDiscovery(profile: ProfileRuntime): Promise<string[]> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "refined-agy-model-disc-"));
  try {
    const session = await profile.runtime.newSession({ cwd: scratchDir });
    try {
      return extractModelsFromSession(session);
    } finally {
      profile.runtime.forgetSession(session.sessionId);
    }
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extracts unique model IDs from an ACP session state.
 */
export function extractModelsFromSession(session: SessionState): string[] {
  const models = new Set<string>();

  // 1. Check session.models.availableModels
  if (session.models && Array.isArray(session.models.availableModels)) {
    for (const item of session.models.availableModels) {
      if (item && typeof item.modelId === "string" && item.modelId.trim()) {
        models.add(item.modelId.trim());
      }
    }
  }

  // 2. Fallback or addition from session.configOptions where id === "model"
  if (session.configOptions && Array.isArray(session.configOptions)) {
    const modelConfig = session.configOptions.find((opt) => opt.id === "model");
    if (modelConfig && Array.isArray(modelConfig.options)) {
      for (const choice of modelConfig.options) {
        if (choice && typeof choice.value === "string" && choice.value.trim()) {
          models.add(choice.value.trim());
        }
      }
    }
  }

  return Array.from(models);
}

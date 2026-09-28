import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProfileConfig } from "../profiles/types.js";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface ServerConfig {
  host: string;
  port: number;
  apiKey?: string | undefined;
  bodyLimitBytes: number;
  allowInsecureExternalBind: boolean;
  profiles: ProfileConfig[];
  profilesFile?: string | undefined;
  shutdownGraceMs: number;
  responseRegistryMaxEntries?: number | undefined;
  responseRegistryTtlMs?: number | undefined;
}


export interface ServerConfigInput {
  host?: string | undefined;
  port?: number | undefined;
  apiKey?: string | undefined;
  bodyLimitBytes?: number | undefined;
  allowInsecureExternalBind?: boolean | undefined;
  profiles?: ProfileConfig[] | undefined;
  profilesFile?: string | undefined;
  shutdownGraceMs?: number | undefined;
  responseRegistryMaxEntries?: number | undefined;
  responseRegistryTtlMs?: number | undefined;
}


/**
 * Expands '~' or '~/...' to user home directory and normalizes to an absolute path.
 */
export function expandPath(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.resolve(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

/**
 * Determines whether a host string refers to local loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.0" ||
    normalized.startsWith("127.")
  );
}

/**
 * Validates server configuration.
 * Throws ConfigurationError immediately on any invalid parameter.
 */
export function validateConfig(config: ServerConfig): void {
  // 1. Host validation
  if (!config.host || typeof config.host !== "string" || config.host.trim().length === 0) {
    throw new ConfigurationError("Server host cannot be empty");
  }

  // 2. Port validation (0 is allowed for ephemeral/test ports)
  if (
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535
  ) {
    throw new ConfigurationError(
      `Invalid server port: ${String(config.port)}. Port must be an integer between 0 and 65535.`,
    );
  }

  // 3. Body limit validation
  if (
    !Number.isInteger(config.bodyLimitBytes) ||
    config.bodyLimitBytes <= 0
  ) {
    throw new ConfigurationError(
      `Invalid body limit: ${String(config.bodyLimitBytes)}. Body limit must be a positive integer.`,
    );
  }

  // 4. Shutdown grace validation
  if (
    !Number.isInteger(config.shutdownGraceMs) ||
    config.shutdownGraceMs < 0
  ) {
    throw new ConfigurationError(
      `Invalid shutdownGraceMs: ${String(config.shutdownGraceMs)}. Must be a non-negative integer.`,
    );
  }

  // 5. Response registry validation
  if (config.responseRegistryMaxEntries !== undefined) {
    if (
      !Number.isInteger(config.responseRegistryMaxEntries) ||
      config.responseRegistryMaxEntries <= 0
    ) {
      throw new ConfigurationError(
        `Invalid responseRegistryMaxEntries: ${String(config.responseRegistryMaxEntries)}. Must be a positive integer.`,
      );
    }
  }

  if (config.responseRegistryTtlMs !== undefined) {
    if (
      !Number.isInteger(config.responseRegistryTtlMs) ||
      config.responseRegistryTtlMs <= 0
    ) {
      throw new ConfigurationError(
        `Invalid responseRegistryTtlMs: ${String(config.responseRegistryTtlMs)}. Must be a positive integer.`,
      );
    }
  }


  // 6. API Key validation

  if (config.apiKey !== undefined && config.apiKey.trim().length === 0) {
    throw new ConfigurationError("REFINED_AGY_API_KEY was provided but is empty");
  }

  // 5. Security check: Fail closed if non-loopback bind without API key
  if (
    !isLoopbackHost(config.host) &&
    !config.apiKey &&
    !config.allowInsecureExternalBind
  ) {
    throw new ConfigurationError(
      `Security violation: Refusing to bind to non-loopback address '${config.host}' without an API key. ` +
        "Antigravity executes tools headless. Set REFINED_AGY_API_KEY or explicitly enable allowInsecureExternalBind.",
    );
  }

  // 6. Profiles validation
  for (const profile of config.profiles) {
    if (!profile.id || typeof profile.id !== "string" || profile.id.trim().length === 0) {
      throw new ConfigurationError("Profile id cannot be empty");
    }
    if (!profile.geminiHome || typeof profile.geminiHome !== "string" || profile.geminiHome.trim().length === 0) {
      throw new ConfigurationError(`Profile '${profile.id}' has an empty geminiHome path`);
    }
  }
}

/**
 * Loads configuration from environment variables and optional input overrides.
 */
export function loadConfigFromEnv(input: ServerConfigInput = {}): ServerConfig {
  const host =
    input.host ??
    process.env["REFINED_AGY_HOST"] ??
    "127.0.0.1";

  const rawPort =
    input.port !== undefined
      ? input.port
      : process.env["REFINED_AGY_PORT"] !== undefined
        ? parseInt(process.env["REFINED_AGY_PORT"], 10)
        : 8787;

  const rawBodyLimit =
    input.bodyLimitBytes !== undefined
      ? input.bodyLimitBytes
      : process.env["REFINED_AGY_BODY_LIMIT"] !== undefined
        ? parseInt(process.env["REFINED_AGY_BODY_LIMIT"], 10)
        : 1024 * 1024; // 1 MiB

  const apiKey =
    input.apiKey !== undefined
      ? input.apiKey
      : process.env["REFINED_AGY_API_KEY"] !== undefined && process.env["REFINED_AGY_API_KEY"].trim() !== ""
        ? process.env["REFINED_AGY_API_KEY"].trim()
        : undefined;

  const allowInsecure =
    input.allowInsecureExternalBind ??
    (process.env["REFINED_AGY_ALLOW_INSECURE_BIND"] === "1" ||
      process.env["REFINED_AGY_ALLOW_INSECURE_BIND"] === "true");

  const shutdownGraceMs =
    input.shutdownGraceMs !== undefined
      ? input.shutdownGraceMs
      : process.env["REFINED_AGY_SHUTDOWN_GRACE_MS"] !== undefined
        ? parseInt(process.env["REFINED_AGY_SHUTDOWN_GRACE_MS"], 10)
        : 15_000;

  const responseRegistryMaxEntries =
    input.responseRegistryMaxEntries !== undefined
      ? input.responseRegistryMaxEntries
      : process.env["REFINED_AGY_RESPONSE_REGISTRY_MAX_ENTRIES"] !== undefined
        ? parseInt(process.env["REFINED_AGY_RESPONSE_REGISTRY_MAX_ENTRIES"], 10)
        : 1000;

  const responseRegistryTtlMs =
    input.responseRegistryTtlMs !== undefined
      ? input.responseRegistryTtlMs
      : process.env["REFINED_AGY_RESPONSE_REGISTRY_TTL_MS"] !== undefined
        ? parseInt(process.env["REFINED_AGY_RESPONSE_REGISTRY_TTL_MS"], 10)
        : 3_600_000; // 1 hour

  let profilesFile = input.profilesFile ?? process.env["REFINED_AGY_PROFILES_FILE"];
  let loadedProfiles: ProfileConfig[] = [];

  if (input.profiles && input.profiles.length > 0) {
    loadedProfiles = input.profiles.map((p) => ({
      ...p,
      geminiHome: expandPath(p.geminiHome),
    }));
  } else if (profilesFile) {
    profilesFile = expandPath(profilesFile);
    if (!fs.existsSync(profilesFile)) {
      throw new ConfigurationError(`Profiles configuration file not found: ${profilesFile}`);
    }
    try {
      const content = fs.readFileSync(profilesFile, "utf-8");
      const parsed = JSON.parse(content);
      const rawList = Array.isArray(parsed) ? parsed : parsed.profiles;
      if (!Array.isArray(rawList)) {
        throw new ConfigurationError(`Profiles file ${profilesFile} must contain a JSON array or { profiles: [] }`);
      }
      loadedProfiles = rawList.map((entry: Record<string, unknown>) => ({
        id: String(entry["id"] ?? ""),
        geminiHome: expandPath(String(entry["geminiHome"] ?? "")),
        priority: typeof entry["priority"] === "number" ? entry["priority"] : 100,
        enabled: typeof entry["enabled"] === "boolean" ? entry["enabled"] : true,
        sessionMode:
          entry["sessionMode"] === "default" || entry["sessionMode"] === "auto_edit" || entry["sessionMode"] === "yolo"
            ? entry["sessionMode"]
            : "yolo",
        env: typeof entry["env"] === "object" && entry["env"] !== null ? (entry["env"] as Record<string, string>) : undefined,
      }));
    } catch (err) {
      if (err instanceof ConfigurationError) throw err;
      throw new ConfigurationError(`Failed to parse profiles file ${profilesFile}: ${String(err)}`);
    }
  }

  const config: ServerConfig = {
    host,
    port: rawPort,
    apiKey,
    bodyLimitBytes: rawBodyLimit,
    allowInsecureExternalBind: allowInsecure,
    profiles: loadedProfiles,
    shutdownGraceMs,
    responseRegistryMaxEntries,
    responseRegistryTtlMs,
    ...(profilesFile ? { profilesFile } : {}),
  };

  validateConfig(config);
  return config;
}


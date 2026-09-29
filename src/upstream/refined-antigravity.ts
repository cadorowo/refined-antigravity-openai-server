import { spawn } from "node:child_process";
import path from "node:path";
import {
  createAntigravityConnector,
  getLatestSessionUsage,
  type AcpConnector,
  type AcpStreamMessage,
} from "@simonepri/refined-antigravity-acp";

export interface RuntimeConnectorOptions {
  geminiHome?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface ExtractedSessionUsage {
  usedTokens: number;
  maxTokens: number;
  promptTokens: number;
  candidateTokens: number;
}

/**
 * Extracts authentic token usage metrics from an ACP conversation SQLite database.
 * If geminiHome is provided, resolves the profile-specific database path;
 * otherwise delegates to default GEMINI_HOME resolution.
 */
export function getProfileSessionUsage(
  sessionId: string,
  geminiHome?: string | undefined,
): ExtractedSessionUsage | null {
  const customDbPath = geminiHome
    ? path.join(geminiHome, "antigravity-acp", "conversations", `${sessionId}.db`)
    : undefined;
  return getLatestSessionUsage(sessionId, customDbPath);
}

/**
 * Single integration boundary with refined-antigravity-acp.
 *
 * Keep imports from the upstream package confined to this module whenever
 * practical. If the public upstream API changes, adapt it here rather than
 * spreading compatibility changes throughout the rest of the codebase.
 */
export function createRuntimeConnector(options: RuntimeConnectorOptions = {}): AcpConnector {
  if (!options.geminiHome && !options.env) {
    return createAntigravityConnector();
  }

  return createAntigravityConnector(undefined, {
    spawnProcess: (cmd, args) => {
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        BROWSER: "false",
        ...(options.env ?? {}),
        ...(options.geminiHome ? { GEMINI_HOME: options.geminiHome } : {}),
      };

      return spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
    },
  });
}

export type { AcpConnector, AcpStreamMessage };

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProfileRuntime } from "../profiles/profile-runtime.js";

export interface ProfileTarget {
  id: string;
  geminiHome: string;
}

export interface ProfileProbeOptions {
  profiles: ProfileTarget[];
  rootDir?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface SingleProfileProbeResult {
  started: boolean;
  sessionCreated: boolean;
  sessionId?: string | undefined;
  workspace: string;
  geminiHome: string;
  outputFileCreated: boolean;
  outputValid: boolean;
  terminalExecutionObserved: boolean;
  stopReason?: string | undefined;
  error?: string | undefined;
  credentialFingerprint?: string | undefined;
  durationMs: number;
}

export interface ProfileIsolationProbeReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  profiles: Record<string, SingleProfileProbeResult>;
  assessment: {
    bothRunningConcurrently: boolean;
    workspacesIsolated: boolean;
    credentialsAppearIsolated: boolean;
    credentialNote?: string | undefined;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;

async function checkFile(filePath: string): Promise<{ exists: boolean; content?: string }> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { exists: true, content };
  } catch {
    return { exists: false };
  }
}

async function computeCredentialFingerprint(geminiHome: string): Promise<string | undefined> {
  const candidatePaths = [
    path.join(geminiHome, "antigravity-acp", "acp_token.json"),
    path.join(geminiHome, "antigravity-acp", "settings.json"),
    path.join(geminiHome, "antigravity-acp", "credentials.json"),
    path.join(geminiHome, "settings.json"),
  ];

  for (const candidate of candidatePaths) {
    try {
      const data = await fs.readFile(candidate);
      return crypto.createHash("sha256").update(data).digest("hex");
    } catch {
      // Continue searching
    }
  }

  // Scan antigravity-acp directory if present
  try {
    const acpDir = path.join(geminiHome, "antigravity-acp");
    const entries = await fs.readdir(acpDir);
    const hash = crypto.createHash("sha256");
    let hasData = false;
    for (const entry of entries) {
      if (entry.includes("token") || entry.includes("auth") || entry.endsWith(".json")) {
        try {
          const content = await fs.readFile(path.join(acpDir, entry));
          hash.update(content);
          hasData = true;
        } catch {}
      }
    }
    if (hasData) {
      return hash.digest("hex");
    }
  } catch {}

  return undefined;
}

async function runProbeForProfile(
  target: ProfileTarget,
  rootDir: string,
  timeoutMs: number,
  concurrencyWitness: { runningCount: number; maxConcurrent: number },
): Promise<SingleProfileProbeResult> {
  const startTime = Date.now();
  const workspace = await fs.mkdtemp(path.join(rootDir, `refined-agy-isolation-${target.id}-`));
  const marker = `PROFILE_${target.id.toUpperCase()}_MARKER_${Date.now()}`;
  const inputFile = path.join(workspace, "probe-input.txt");
  const outputFile = path.join(workspace, "probe-output.txt");

  await fs.writeFile(inputFile, `${marker}\n`, "utf8");

  const profile = new ProfileRuntime({
    config: {
      id: target.id,
      geminiHome: target.geminiHome,
      sessionMode: "yolo",
    },
  });

  let started = false;
  let sessionCreated = false;
  let sessionId: string | undefined;
  let terminalExecutionObserved = false;
  let stopReason: string | undefined;
  let errorMsg: string | undefined;

  concurrencyWitness.runningCount++;
  concurrencyWitness.maxConcurrent = Math.max(
    concurrencyWitness.maxConcurrent,
    concurrencyWitness.runningCount,
  );

  try {
    await profile.start();
    started = true;

    const session = await profile.createSession({ cwd: workspace });
    sessionCreated = true;
    sessionId = session.sessionId;

    const promptText = [
      `This is an isolated concurrent profile probe for profile '${target.id}'.`,
      "1. Read probe-input.txt.",
      `2. Create probe-output.txt containing exactly ${marker} followed by a newline.`,
      "3. Run pwd.",
      "Finish with a concise summary.",
    ].join("\n");

    const turn = profile.runtime.prompt(session.sessionId, promptText, { timeoutMs });

    (async () => {
      try {
        for await (const update of turn.updates) {
          const payload = update.update;
          const title = typeof payload["title"] === "string" ? payload["title"] : "";
          const kind = typeof payload["kind"] === "string" ? payload["kind"] : "";
          if (title.toLowerCase().includes("pwd") || kind === "execute") {
            terminalExecutionObserved = true;
          }
        }
      } catch {}
    })();

    const result = await turn.result;
    stopReason = result.stopReason;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    concurrencyWitness.runningCount--;
    await profile.close().catch(() => {});
  }

  const { exists: outputExists, content: outputContent } = await checkFile(outputFile);
  const outputValid = outputExists && outputContent?.trim() === marker;
  const credentialFingerprint = await computeCredentialFingerprint(target.geminiHome);

  return {
    started,
    sessionCreated,
    sessionId,
    workspace,
    geminiHome: target.geminiHome,
    outputFileCreated: outputExists,
    outputValid,
    terminalExecutionObserved,
    stopReason,
    error: errorMsg,
    credentialFingerprint,
    durationMs: Date.now() - startTime,
  };
}

export async function runProfileIsolationProbe(
  options: ProfileProbeOptions,
): Promise<ProfileIsolationProbeReport> {
  const startedAt = new Date().toISOString();
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : os.tmpdir();
  await fs.mkdir(rootDir, { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const concurrencyWitness = { runningCount: 0, maxConcurrent: 0 };

  process.stdout.write(
    `[probe:profiles] Starting concurrent execution for ${options.profiles.length} profiles...\n`,
  );

  // Execute all profiles in PARALLEL via Promise.all
  const probePromises = options.profiles.map((target) =>
    runProbeForProfile(target, rootDir, timeoutMs, concurrencyWitness).then((res) => ({
      target,
      res,
    })),
  );

  const settled = await Promise.all(probePromises);
  const finishedAt = new Date().toISOString();

  const results: Record<string, SingleProfileProbeResult> = {};
  for (const { target, res } of settled) {
    results[target.id] = res;
    process.stdout.write(
      `[probe:profiles] Profile '${target.id}': started=${res.started}, valid=${res.outputValid}, stopReason=${res.stopReason ?? "none"}\n`,
    );
  }

  const bothRunningConcurrently = concurrencyWitness.maxConcurrent >= 2;
  const workspaces = Object.values(results).map((r) => r.workspace);
  const workspacesIsolated = new Set(workspaces).size === workspaces.length;

  const fingerprints = Object.values(results)
    .map((r) => r.credentialFingerprint)
    .filter((f): f is string => typeof f === "string");

  let credentialsAppearIsolated = false;
  let credentialNote: string | undefined;

  if (fingerprints.length >= 2) {
    credentialsAppearIsolated = new Set(fingerprints).size === fingerprints.length;
  } else {
    credentialNote = "credential isolation not directly verifiable from files";
    // Check if separate gemini homes were provided
    const homes = Object.values(results).map((r) => r.geminiHome);
    credentialsAppearIsolated = new Set(homes).size === homes.length;
  }

  return {
    version: 1,
    startedAt,
    finishedAt,
    profiles: results,
    assessment: {
      bothRunningConcurrently,
      workspacesIsolated,
      credentialsAppearIsolated,
      credentialNote,
    },
  };
}

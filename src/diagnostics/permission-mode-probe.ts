import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AcpRuntimeClient } from "../acp/runtime-client.js";
import {
  CallbackPermissionHandler,
  type PermissionDecision,
  type PermissionRequest,
} from "../acp/permission-handler.js";

export interface PermissionModeProbeOptions {
  rootDir?: string | undefined;
  modes?: string[] | undefined;
  model?: string | undefined;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  timeoutMs?: number | undefined;
}

export interface ObservedPermissionRequest {
  id: string | number;
  timestamp: string;
  toolCallId?: string | undefined;
  toolKind?: string | undefined;
  title?: string | undefined;
  rawInput?: unknown | undefined;
  options: Array<{ optionId: string; kind: string; name?: string | undefined }>;
  decisionOutcome: string;
  decisionOptionId?: string | undefined;
}

export interface ModeProbeResult {
  mode: string;
  workspace: string;
  availableModesInSession: string[];
  permissionRequestsCount: number;
  permissionRequests: ObservedPermissionRequest[];
  toolKindsRequestingPermission: string[];
  outputFileCreated: boolean;
  outputFileValid: boolean;
  terminalExecutionObserved: boolean;
  stopReason?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  error?: string | undefined;
  durationMs: number;
}

export interface PermissionModeProbeReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  options: {
    modes: string[];
    timeoutMs: number;
    model?: string | undefined;
    reasoningEffort?: string | undefined;
  };
  results: Record<string, ModeProbeResult>;
  summary: {
    modesTested: string[];
    autoEditSuppressesFileEditPermission: boolean;
    yoloSuppressesAllPermissions: boolean;
    recommendedProductionMode: string;
    rationale: string;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MODES = ["default", "auto_edit", "yolo"];

async function checkFile(filePath: string): Promise<{ exists: boolean; content?: string }> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { exists: true, content };
  } catch {
    return { exists: false };
  }
}

export async function runSingleModeProbe(
  mode: string,
  options: PermissionModeProbeOptions = {},
): Promise<ModeProbeResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : os.tmpdir();
  await fs.mkdir(rootDir, { recursive: true });

  const workspace = await fs.mkdtemp(path.join(rootDir, `refined-agy-mode-${mode}-`));
  const marker = `PROBE_MODE_${mode.toUpperCase()}_${Date.now()}`;
  const inputFile = path.join(workspace, "probe-input.txt");
  const outputFile = path.join(workspace, "probe-output.txt");

  await fs.writeFile(inputFile, `${marker}\n`, "utf8");

  const recordedRequests: ObservedPermissionRequest[] = [];
  let reqCounter = 0;

  // Handler grants permission with allow_once so the turn can proceed,
  // allowing us to observe subsequent actions and tool requests.
  const permissionHandler = new CallbackPermissionHandler(async (req: PermissionRequest) => {
    const id = ++reqCounter;
    const optionsList = Array.isArray(req.options) ? req.options : [];
    const allowOption = optionsList.find(
      (opt) => opt.kind === "allow_once" || opt.kind === "allow_always",
    );

    let decision: PermissionDecision;
    if (allowOption) {
      decision = { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    } else {
      decision = { outcome: { outcome: "cancelled" } };
    }

    recordedRequests.push({
      id,
      timestamp: new Date().toISOString(),
      toolCallId: req.toolCall?.toolCallId,
      toolKind: req.toolCall?.kind,
      title: req.toolCall?.title,
      rawInput: req.toolCall?.rawInput,
      options: optionsList.map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
      decisionOutcome: decision.outcome.outcome,
      decisionOptionId:
        decision.outcome.outcome === "selected" ? decision.outcome.optionId : undefined,
    });

    return decision;
  });

  const runtime = new AcpRuntimeClient({
    permissionHandler,
  });

  let terminalExecutionObserved = false;
  let stopReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let errorMsg: string | undefined;
  let availableModesInSession: string[] = [];

  try {
    await runtime.start();

    const session = await runtime.newSession({ cwd: workspace });
    availableModesInSession = session.modes?.availableModes.map((m) => m.id) ?? [];

    if (mode !== "default") {
      await runtime.setMode(session.sessionId, mode);
    }

    if (options.model) {
      await runtime.setConfigOption(session.sessionId, "model", options.model);
    }

    if (options.reasoningEffort) {
      await runtime.setConfigOption(session.sessionId, "thought_level", options.reasoningEffort);
    }

    const promptText = [
      "This is a controlled ACP transport probe inside an isolated temporary workspace.",
      "Use your normal coding tools and do only these benign actions:",
      "1. Read probe-input.txt.",
      `2. Create probe-output.txt containing exactly ${marker} followed by a newline.`,
      "3. If a shell/terminal tool is normally available, run pwd and no other shell command.",
      "Do not access paths outside the current workspace. Finish with a very short summary of what succeeded.",
    ].join("\n");

    const turn = runtime.prompt(session.sessionId, promptText, { timeoutMs });

    // Track streaming updates for terminal execution and tool calls
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
      } catch {
        // Updates iteration can fail if prompt fails; handled below
      }
    })();

    const result = await turn.result;
    stopReason = result.stopReason;
    usage = result.usage as Record<string, unknown> | undefined;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    await runtime.close();
  }

  const { exists: outputExists, content: outputContent } = await checkFile(outputFile);
  const outputFileValid = outputExists && outputContent?.trim() === marker;

  // Also check if any permission request was for terminal execution
  if (
    recordedRequests.some(
      (r) => r.toolKind === "execute" || r.title?.toLowerCase().includes("pwd"),
    )
  ) {
    terminalExecutionObserved = true;
  }

  const toolKindsRequestingPermission = [
    ...new Set(
      recordedRequests
        .map((r) => r.toolKind)
        .filter((k): k is string => typeof k === "string" && k.length > 0),
    ),
  ].sort();

  return {
    mode,
    workspace,
    availableModesInSession,
    permissionRequestsCount: recordedRequests.length,
    permissionRequests: recordedRequests,
    toolKindsRequestingPermission,
    outputFileCreated: outputExists,
    outputFileValid,
    terminalExecutionObserved,
    stopReason,
    usage,
    error: errorMsg,
    durationMs: Date.now() - startTime,
  };
}

export async function runPermissionModeProbe(
  options: PermissionModeProbeOptions = {},
): Promise<PermissionModeProbeReport> {
  const startedAt = new Date().toISOString();
  const modesToTest = options.modes ?? DEFAULT_MODES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: Record<string, ModeProbeResult> = {};

  for (const mode of modesToTest) {
    process.stdout.write(`\n[probe:modes] Testing mode: ${mode}...\n`);
    const result = await runSingleModeProbe(mode, options);
    results[mode] = result;
    process.stdout.write(
      `[probe:modes] Mode ${mode} finished: ${result.permissionRequestsCount} permission request(s), outputFileValid: ${result.outputFileValid}, terminal: ${result.terminalExecutionObserved}, stopReason: ${result.stopReason ?? "none"}\n`,
    );
  }

  const finishedAt = new Date().toISOString();

  // Deduce conclusions
  const defaultRes = results["default"];
  const autoEditRes = results["auto_edit"];
  const yoloRes = results["yolo"];

  const defaultHasEdit = defaultRes?.toolKindsRequestingPermission.includes("edit") ?? false;
  const autoEditHasEdit = autoEditRes?.toolKindsRequestingPermission.includes("edit") ?? false;
  const autoEditSuppressesFileEditPermission = defaultHasEdit && !autoEditHasEdit;

  const yoloRequests = yoloRes?.permissionRequestsCount ?? 0;
  const yoloSuppressesAllPermissions = yoloRequests === 0;

  let recommendedProductionMode = "default";
  let rationale = "";

  if (yoloSuppressesAllPermissions) {
    recommendedProductionMode = "yolo";
    rationale =
      "YOLO mode completely eliminates interactive permission requests while allowing full internal file and terminal execution within AGY.";
  } else if (autoEditSuppressesFileEditPermission) {
    recommendedProductionMode = "auto_edit";
    rationale =
      "Auto Edit suppresses file edit permission prompts while maintaining execution prompts.";
  } else {
    recommendedProductionMode = "default";
    rationale =
      "Default mode with an automated PolicyPermissionHandler ('allow-once' or 'allow-always') provides full control over approvals.";
  }

  return {
    version: 1,
    startedAt,
    finishedAt,
    options: {
      modes: modesToTest,
      timeoutMs,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    },
    results,
    summary: {
      modesTested: modesToTest,
      autoEditSuppressesFileEditPermission,
      yoloSuppressesAllPermissions,
      recommendedProductionMode,
      rationale,
    },
  };
}

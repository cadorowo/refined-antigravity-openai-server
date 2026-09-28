import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createRuntimeConnector,
  type AcpStreamMessage,
} from "../upstream/refined-antigravity.js";

type RpcId = string | number;
type PermissionPolicy = "reject" | "allow-once";

export interface HeadlessAcpProbeOptions {
  rootDir?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  timeoutMs?: number;
  advertiseClientTools?: boolean;
  permissionPolicy?: PermissionPolicy;
}

export interface ProbeWireEvent {
  at: string;
  direction: "client->agent" | "agent->client";
  message: AcpStreamMessage;
}

export interface ProbeClientRequest {
  id: RpcId;
  method: string;
  params?: unknown;
  response: AcpStreamMessage;
}

export interface HeadlessAcpProbeReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  workspace: string;
  options: {
    timeoutMs: number;
    advertiseClientTools: boolean;
    permissionPolicy: PermissionPolicy;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high";
  };
  initializeResult?: unknown;
  sessionNewResult?: unknown;
  modelConfigResult?: unknown;
  reasoningConfigResult?: unknown;
  promptResult?: unknown;
  promptError?: string;
  clientRequests: ProbeClientRequest[];
  observedClientMethods: string[];
  sessionUpdateCounts: Record<string, number>;
  workspaceEvidence: {
    inputFile: string;
    outputFile: string;
    outputExists: boolean;
    outputContent?: string;
  };
  assessment: {
    permissionRequestsObserved: boolean;
    clientFsRequestsObserved: boolean;
    clientTerminalRequestsObserved: boolean;
    otherClientRequestsObserved: string[];
    serverSideWriteObserved: boolean;
    likelyNeedsClientFsHost: boolean;
    likelyNeedsClientTerminalHost: boolean;
  };
  wire: ProbeWireEvent[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const PROBE_MARKER = "HEADLESS_ACP_PROBE";
const CLIENT_METHOD_PREFIXES = ["fs/", "terminal/"] as const;

function isRequest(message: AcpStreamMessage): message is AcpStreamMessage & {
  id: RpcId;
  method: string;
  params?: unknown;
} {
  return (
    "method" in message &&
    "id" in message &&
    (typeof message.id === "string" || typeof message.id === "number")
  );
}

function isResponse(message: AcpStreamMessage): message is AcpStreamMessage & { id: RpcId } {
  return (
    "id" in message &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    ("result" in message || "error" in message)
  );
}

function getSessionUpdateKind(message: AcpStreamMessage): string | undefined {
  if (!("method" in message) || message.method !== "session/update") return undefined;
  if (!("params" in message) || typeof message.params !== "object" || message.params === null) {
    return "unknown";
  }
  const update = (message.params as { update?: unknown }).update;
  if (typeof update !== "object" || update === null) return "unknown";
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
  return typeof kind === "string" ? kind : "unknown";
}

function rpcSuccess(id: RpcId, result: unknown): AcpStreamMessage {
  return { jsonrpc: "2.0", id, result } as AcpStreamMessage;
}

function rpcError(id: RpcId, code: number, message: string): AcpStreamMessage {
  return { jsonrpc: "2.0", id, error: { code, message } } as AcpStreamMessage;
}

function permissionResponse(
  request: AcpStreamMessage & { id: RpcId; method: string; params?: unknown },
  policy: PermissionPolicy,
): AcpStreamMessage {
  if (policy === "allow-once") {
    const params = request.params;
    const options =
      typeof params === "object" && params !== null && Array.isArray((params as { options?: unknown }).options)
        ? (params as { options: unknown[] }).options
        : [];
    const allowOnce = options.find(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        (option as { kind?: unknown }).kind === "allow_once" &&
        typeof (option as { optionId?: unknown }).optionId === "string",
    ) as { optionId: string } | undefined;

    if (allowOnce) {
      return rpcSuccess(request.id, {
        outcome: { outcome: "selected", optionId: allowOnce.optionId },
      });
    }
  }

  const params = request.params;
  const options =
    typeof params === "object" && params !== null && Array.isArray((params as { options?: unknown }).options)
      ? (params as { options: unknown[] }).options
      : [];
  const reject = options.find(
    (option) =>
      typeof option === "object" &&
      option !== null &&
      ((option as { kind?: unknown }).kind === "reject_once" ||
        (option as { kind?: unknown }).kind === "reject_always") &&
      typeof (option as { optionId?: unknown }).optionId === "string",
  ) as { optionId: string } | undefined;

  if (reject) {
    return rpcSuccess(request.id, {
      outcome: { outcome: "selected", optionId: reject.optionId },
    });
  }

  return rpcSuccess(request.id, { outcome: { outcome: "cancelled" } });
}

function buildClientCapabilities(advertiseClientTools: boolean): Record<string, unknown> {
  if (!advertiseClientTools) {
    return {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    };
  }

  return {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runHeadlessAcpProbe(
  options: HeadlessAcpProbeOptions = {},
): Promise<HeadlessAcpProbeReport> {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const advertiseClientTools = options.advertiseClientTools ?? false;
  const permissionPolicy = options.permissionPolicy ?? "reject";
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : os.tmpdir();
  await fs.mkdir(rootDir, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(rootDir, "refined-agy-headless-probe-"));
  const inputFile = path.join(workspace, "probe-input.txt");
  const outputFile = path.join(workspace, "probe-output.txt");
  await fs.writeFile(inputFile, `${PROBE_MARKER}\n`, "utf8");

  const wire: ProbeWireEvent[] = [];
  const clientRequests: ProbeClientRequest[] = [];
  const sessionUpdateCounts: Record<string, number> = {};
  const pending = new Map<RpcId, PendingRequest>();
  let nextId = 1;
  let closed = false;

  const connector = createRuntimeConnector();
  const stream = await connector();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let writeChain: Promise<void> = Promise.resolve();

  const send = async (message: AcpStreamMessage): Promise<void> => {
    wire.push({ at: new Date().toISOString(), direction: "client->agent", message });
    const write = writeChain.then(() => writer.write(message));
    writeChain = write.catch(() => {});
    await write;
  };

  const request = async (method: string, params: unknown, requestTimeoutMs = timeoutMs): Promise<unknown> => {
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} response after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
    });

    try {
      await send({ jsonrpc: "2.0", id, method, params } as AcpStreamMessage);
    } catch (error) {
      const entry = pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  };

  const respondToClientRequest = async (
    message: AcpStreamMessage & { id: RpcId; method: string; params?: unknown },
  ): Promise<void> => {
    let response: AcpStreamMessage;
    if (message.method === "session/request_permission") {
      response = permissionResponse(message, permissionPolicy);
    } else {
      response = rpcError(
        message.id,
        -32601,
        `Headless probe intentionally does not implement client method ${message.method}`,
      );
    }
    clientRequests.push({
      id: message.id,
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
      response,
    });
    await send(response);
  };

  const readLoop = (async (): Promise<void> => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        if (!value) continue;

        wire.push({ at: new Date().toISOString(), direction: "agent->client", message: value });
        const updateKind = getSessionUpdateKind(value);
        if (updateKind) {
          sessionUpdateCounts[updateKind] = (sessionUpdateCounts[updateKind] ?? 0) + 1;
        }

        if (isResponse(value)) {
          const entry = pending.get(value.id);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(value.id);
            if ("error" in value) {
              entry.reject(new Error(`ACP ${JSON.stringify(value.error)}`));
            } else if ("result" in value) {
              entry.resolve(value.result);
            } else {
              entry.reject(new Error(`Malformed ACP response for request ${String(value.id)}`));
            }
          }
          continue;
        }

        if (isRequest(value)) {
          await respondToClientRequest(value);
        }
      }
    } catch (error) {
      if (!closed) {
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`ACP read loop failed for request ${String(id)}: ${errorMessage(error)}`));
        }
        pending.clear();
      }
    }
  })();

  let initializeResult: unknown;
  let sessionNewResult: unknown;
  let modelConfigResult: unknown;
  let reasoningConfigResult: unknown;
  let promptResult: unknown;
  let promptError: string | undefined;
  let sessionId: string | undefined;

  try {
    initializeResult = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: buildClientCapabilities(advertiseClientTools),
      clientInfo: { name: "refined-antigravity-openai-server-probe", version: "0.1.0" },
    });

    sessionNewResult = await request("session/new", {
      cwd: workspace,
      mcpServers: [],
    });

    if (
      typeof sessionNewResult !== "object" ||
      sessionNewResult === null ||
      typeof (sessionNewResult as { sessionId?: unknown }).sessionId !== "string"
    ) {
      throw new Error(`session/new returned no sessionId: ${JSON.stringify(sessionNewResult)}`);
    }
    sessionId = (sessionNewResult as { sessionId: string }).sessionId;

    if (options.model) {
      modelConfigResult = await request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: options.model,
      });
    }

    if (options.reasoningEffort) {
      reasoningConfigResult = await request("session/set_config_option", {
        sessionId,
        configId: "reasoning_effort",
        value: options.reasoningEffort,
      });
    }

    const prompt = [
      "This is a controlled ACP transport probe inside an isolated temporary workspace.",
      "Use your normal coding tools and do only these benign actions:",
      "1. Read probe-input.txt.",
      `2. Create probe-output.txt containing exactly ${PROBE_MARKER} followed by a newline.`,
      "3. If a shell/terminal tool is normally available, run pwd and no other shell command.",
      "Do not access paths outside the current workspace. Finish with a very short summary of what succeeded.",
    ].join("\n");

    promptResult = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
  } catch (error) {
    promptError = errorMessage(error);
    if (sessionId) {
      try {
        await send({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId },
        } as AcpStreamMessage);
      } catch {
        // Best-effort cleanup only.
      }
    }
  } finally {
    closed = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Headless probe closed before ACP response arrived"));
    }
    pending.clear();
    try {
      await writer.close();
    } catch {}
    try {
      await reader.cancel();
    } catch {}
    await readLoop.catch(() => {});
  }

  const outputExists = await fileExists(outputFile);
  const outputContent = outputExists ? await fs.readFile(outputFile, "utf8") : undefined;
  const observedClientMethods = [...new Set(clientRequests.map((requestEntry) => requestEntry.method))].sort();
  const clientFsRequestsObserved = observedClientMethods.some((method) => method.startsWith("fs/"));
  const clientTerminalRequestsObserved = observedClientMethods.some((method) =>
    method.startsWith("terminal/"),
  );
  const permissionRequestsObserved = observedClientMethods.includes("session/request_permission");
  const otherClientRequestsObserved = observedClientMethods.filter(
    (method) =>
      method !== "session/request_permission" &&
      !CLIENT_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix)),
  );

  return {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    workspace,
    options: {
      timeoutMs,
      advertiseClientTools,
      permissionPolicy,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    },
    ...(initializeResult === undefined ? {} : { initializeResult }),
    ...(sessionNewResult === undefined ? {} : { sessionNewResult }),
    ...(modelConfigResult === undefined ? {} : { modelConfigResult }),
    ...(reasoningConfigResult === undefined ? {} : { reasoningConfigResult }),
    ...(promptResult === undefined ? {} : { promptResult }),
    ...(promptError === undefined ? {} : { promptError }),
    clientRequests,
    observedClientMethods,
    sessionUpdateCounts,
    workspaceEvidence: {
      inputFile,
      outputFile,
      outputExists,
      ...(outputContent === undefined ? {} : { outputContent }),
    },
    assessment: {
      permissionRequestsObserved,
      clientFsRequestsObserved,
      clientTerminalRequestsObserved,
      otherClientRequestsObserved,
      serverSideWriteObserved: outputExists && outputContent === `${PROBE_MARKER}\n`,
      likelyNeedsClientFsHost: clientFsRequestsObserved,
      likelyNeedsClientTerminalHost: clientTerminalRequestsObserved,
    },
    wire,
  };
}

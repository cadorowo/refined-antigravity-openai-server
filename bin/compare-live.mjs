#!/usr/bin/env node

// One-turn live comparison. Run `pnpm build && node bin/compare-live.mjs`.
// Uses the first profile in profiles.json and the CLI's own cached credentials.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { ProfileManager } from "../dist/src/profiles/profile-manager.js";
import { ProfileRuntime } from "../dist/src/profiles/profile-runtime.js";
import { createServer, NoopServerLogger } from "../dist/src/server/server.js";

const PROMPT = "Reply with exactly AGY_BENCH_OK. Do not use tools.";
const ACP_MODEL = "gemini-3.7-flash";
const CLI_MODEL = "gemini-3.7-flash-low";
const profile = JSON.parse(await fs.readFile("profiles.json", "utf8")).profiles[0];
if (!profile) throw new Error("profiles.json has no profiles");
const results = { date: new Date().toISOString(), acpModel: ACP_MODEL, cliModel: CLI_MODEL, runs: {} };

async function runServer() {
  const runtime = new ProfileRuntime({ config: profile });
  const server = createServer({
    profileManager: new ProfileManager([runtime]),
    logger: new NoopServerLogger(),
    config: { host: "127.0.0.1", port: 0, apiKey: "comparison-local-only" },
  });
  const start = performance.now();
  try {
    await server.start();
    const startupMs = performance.now() - start;
    const requestStart = performance.now();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer comparison-local-only" },
      body: JSON.stringify({ model: ACP_MODEL, reasoning_effort: "low", messages: [{ role: "user", content: PROMPT }] }),
      signal: AbortSignal.timeout(90000),
    });
    const body = await response.json();
    return {
      startupMs: Math.round(startupMs),
      turnMs: Math.round(performance.now() - requestStart),
      status: response.status,
      output: body.choices?.[0]?.message?.content?.trim() ?? null,
      error: body.error?.message ?? null,
      usage: body.usage ?? null,
    };
  } finally {
    await server.close();
  }
}

async function runAcp() {
  const runtime = new ProfileRuntime({ config: profile });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-compare-acp-"));
  const start = performance.now();
  try {
    await runtime.start();
    const startupMs = performance.now() - start;
    const turnStart = performance.now();
    const session = await runtime.runtime.newSession({ cwd });
    if (session.modes?.availableModes.some((mode) => mode.id === "yolo") && session.modes.currentModeId !== "yolo") {
      await runtime.runtime.setMode(session.sessionId, "yolo");
    }
    const model = session.configOptions?.find((option) => option.id === "model");
    if (model && model.currentValue !== ACP_MODEL) {
      await runtime.runtime.setConfigOption(session.sessionId, model.id, ACP_MODEL);
    }
    const thought = session.configOptions?.find((option) => option.id === "thought_level");
    if (thought?.options?.some((option) => option.value === "low") && thought.currentValue !== "low") {
      await runtime.runtime.setConfigOption(session.sessionId, thought.id, "low");
    }
    const turn = runtime.runtime.prompt(session.sessionId, PROMPT, { signal: AbortSignal.timeout(90000) });
    let output = "";
    for await (const update of turn.updates) {
      if (update.sessionUpdate === "agent_message_chunk") {
        output += update.update?.content?.text ?? "";
      }
    }
    const result = await turn.result;
    return {
      startupMs: Math.round(startupMs),
      turnMs: Math.round(performance.now() - turnStart),
      stopReason: result.stopReason,
      output: output.trim(),
      usage: result.usage ?? null,
    };
  } finally {
    await runtime.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

async function runCli() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-compare-cli-"));
  const start = performance.now();
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn("agy", ["--print", PROMPT, "--model", CLI_MODEL, "--output-format", "json", "--print-timeout", "90s"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 100000);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    let parsed;
    try { parsed = JSON.parse(output.stdout); } catch { parsed = {}; }
    return {
      totalMs: Math.round(performance.now() - start),
      exitCode: output.code,
      status: parsed.status ?? null,
      output: parsed.response?.trim() ?? null,
      error: parsed.error ?? (output.code === 0 ? null : output.stderr.slice(-300)),
      usage: parsed.usage ?? null,
    };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

for (const [name, run] of [["server", runServer], ["acp", runAcp], ["cli", runCli]]) {
  try {
    results.runs[name] = await run();
  } catch (error) {
    results.runs[name] = { error: error instanceof Error ? error.message : String(error) };
  }
  console.log(name, results.runs[name]);
}
await fs.writeFile("live-comparison.json", `${JSON.stringify(results, null, 2)}\n`);

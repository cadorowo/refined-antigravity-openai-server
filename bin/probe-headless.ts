#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  runHeadlessAcpProbe,
  type HeadlessAcpProbeOptions,
  type HeadlessAcpProbeReport,
} from "../src/diagnostics/headless-acp-probe.js";

interface CliOptions extends HeadlessAcpProbeOptions {
  reportPath: string;
}

function usage(): string {
  return [
    "Usage: node dist/bin/probe-headless.js [options]",
    "",
    "Options:",
    "  --root <path>                  Parent directory for the isolated probe workspace",
    "  --report <path>                JSON report path (default: ./headless-acp-probe-report.json)",
    "  --model <id>                   Optional ACP model config value",
    "  --effort <low|medium|high>     Optional reasoning_effort config value",
    "  --timeout-ms <ms>              Prompt timeout (default: 120000)",
    "  --advertise-client-tools       Advertise ACP fs + terminal client capabilities",
    "  --permission-policy <policy>   reject (default) or allow-once",
    "  --help                         Show this help",
    "",
    "The default permission policy is safe/reject. Use allow-once only for the isolated",
    "probe prompt if you intentionally want to test whether AGY executes its own tools.",
  ].join("\n");
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    reportPath: path.resolve("headless-acp-probe-report.json"),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--advertise-client-tools") {
      options.advertiseClientTools = true;
      continue;
    }
    if (arg === "--root") {
      options.rootDir = nextValue(args, i, arg);
      i++;
      continue;
    }
    if (arg === "--report") {
      options.reportPath = path.resolve(nextValue(args, i, arg));
      i++;
      continue;
    }
    if (arg === "--model") {
      options.model = nextValue(args, i, arg);
      i++;
      continue;
    }
    if (arg === "--effort") {
      const effort = nextValue(args, i, arg);
      if (effort !== "low" && effort !== "medium" && effort !== "high") {
        throw new Error(`Invalid --effort value: ${effort}`);
      }
      options.reasoningEffort = effort;
      i++;
      continue;
    }
    if (arg === "--timeout-ms") {
      const parsed = Number(nextValue(args, i, arg));
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--timeout-ms must be > 0");
      options.timeoutMs = parsed;
      i++;
      continue;
    }
    if (arg === "--permission-policy") {
      const policy = nextValue(args, i, arg);
      if (policy !== "reject" && policy !== "allow-once") {
        throw new Error(`Invalid --permission-policy value: ${policy}`);
      }
      options.permissionPolicy = policy;
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printSummary(report: HeadlessAcpProbeReport): void {
  const assessment = report.assessment;
  const methods = report.observedClientMethods.length > 0 ? report.observedClientMethods.join(", ") : "none";
  process.stdout.write(
    [
      "Headless ACP probe complete.",
      `Workspace: ${report.workspace}`,
      `Agent->client request methods: ${methods}`,
      `Permission request observed: ${String(assessment.permissionRequestsObserved)}`,
      `Client fs requests observed: ${String(assessment.clientFsRequestsObserved)}`,
      `Client terminal requests observed: ${String(assessment.clientTerminalRequestsObserved)}`,
      `Server-side probe write observed: ${String(assessment.serverSideWriteObserved)}`,
      report.promptError ? `Prompt error: ${report.promptError}` : "Prompt completed without recorded error.",
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  const { reportPath, ...probeOptions } = parseArgs(process.argv.slice(2));
  const report = await runHeadlessAcpProbe(probeOptions);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printSummary(report);
  process.stdout.write(`Report: ${reportPath}\n`);
}

main().catch((error: unknown) => {
  console.error("[headless-acp-probe] Fatal error:", error);
  process.exit(1);
});

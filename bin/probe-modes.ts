#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  runPermissionModeProbe,
  type PermissionModeProbeOptions,
  type PermissionModeProbeReport,
} from "../src/diagnostics/permission-mode-probe.js";

interface CliOptions extends PermissionModeProbeOptions {
  reportPath: string;
}

function usage(): string {
  return [
    "Usage: node dist/bin/probe-modes.js [options]",
    "",
    "Options:",
    "  --root <path>                  Parent directory for the isolated probe workspaces",
    "  --report <path>                JSON report output path (default: ./permission-mode-probe-report.json)",
    "  --modes <list>                 Comma-separated list of modes (default: default,auto_edit,yolo)",
    "  --model <id>                   Optional ACP model config value",
    "  --effort <low|medium|high>     Optional reasoning_effort config value",
    "  --timeout-ms <ms>              Per-mode prompt timeout (default: 120000)",
    "  --help                         Show this help",
    "",
    "Compares ACP behavior across default, auto_edit, and yolo modes.",
  ].join("\n");
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    reportPath: path.resolve("permission-mode-probe-report.json"),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
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
    if (arg === "--modes") {
      options.modes = nextValue(args, i, arg).split(",").map((m) => m.trim());
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printSummary(report: PermissionModeProbeReport): void {
  process.stdout.write("\n========================================\n");
  process.stdout.write("PERMISSION MODE PROBE RESULTS\n");
  process.stdout.write("========================================\n");

  for (const [mode, result] of Object.entries(report.results)) {
    process.stdout.write(`\nMode: ${mode}\n`);
    process.stdout.write(`  Permission requests: ${result.permissionRequestsCount}\n`);
    process.stdout.write(
      `  Tool kinds requesting permission: ${
        result.toolKindsRequestingPermission.length > 0
          ? result.toolKindsRequestingPermission.join(", ")
          : "none"
      }\n`,
    );
    process.stdout.write(`  Output file valid: ${result.outputFileValid}\n`);
    process.stdout.write(`  Terminal execution observed: ${result.terminalExecutionObserved}\n`);
    process.stdout.write(`  Stop reason: ${result.stopReason ?? "unknown"}\n`);
    if (result.error) {
      process.stdout.write(`  Error: ${result.error}\n`);
    }
    process.stdout.write(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s\n`);
  }

  process.stdout.write("\n----------------------------------------\n");
  process.stdout.write(`Recommended production mode: ${report.summary.recommendedProductionMode}\n`);
  process.stdout.write(`Rationale: ${report.summary.rationale}\n`);
  process.stdout.write("========================================\n");
}

async function main(): Promise<void> {
  const { reportPath, ...probeOptions } = parseArgs(process.argv.slice(2));
  const report = await runPermissionModeProbe(probeOptions);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printSummary(report);
  process.stdout.write(`\nReport written to: ${reportPath}\n`);
}

main().catch((error: unknown) => {
  console.error("[probe-modes] Fatal error:", error);
  process.exit(1);
});

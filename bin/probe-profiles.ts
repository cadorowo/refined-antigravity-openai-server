#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  runProfileIsolationProbe,
  type ProfileProbeOptions,
  type ProfileIsolationProbeReport,
  type ProfileTarget,
} from "../src/diagnostics/profile-isolation-probe.js";

interface CliOptions {
  profiles: ProfileTarget[];
  reportPath: string;
  rootDir?: string | undefined;
  timeoutMs?: number | undefined;
}

function usage(): string {
  return [
    "Usage: node dist/bin/probe-profiles.js [options]",
    "",
    "Options:",
    "  --profile <id=path>    Add a profile target (can be specified multiple times)",
    "  --report <path>        JSON report output path (default: ./profile-isolation-probe-report.json)",
    "  --root <path>          Parent directory for isolated test workspaces",
    "  --timeout-ms <ms>      Prompt timeout per profile (default: 120000)",
    "  --help                 Show this help",
    "",
    "Example:",
    "  node dist/bin/probe-profiles.js \\",
    '    --profile account-a="$HOME/.config/refined-agy/profiles/account-a/gemini" \\',
    '    --profile account-b="$HOME/.config/refined-agy/profiles/account-b/gemini"',
  ].join("\n");
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const profiles: ProfileTarget[] = [];
  let reportPath = path.resolve("profile-isolation-probe-report.json");
  let rootDir: string | undefined;
  let timeoutMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--profile") {
      const val = nextValue(args, i, arg);
      i++;
      const eqIdx = val.indexOf("=");
      if (eqIdx <= 0) {
        throw new Error(`Invalid --profile format '${val}'. Expected <id>=<path>`);
      }
      const id = val.slice(0, eqIdx).trim();
      const geminiHome = path.resolve(val.slice(eqIdx + 1).trim());
      profiles.push({ id, geminiHome });
      continue;
    }
    if (arg === "--report") {
      reportPath = path.resolve(nextValue(args, i, arg));
      i++;
      continue;
    }
    if (arg === "--root") {
      rootDir = path.resolve(nextValue(args, i, arg));
      i++;
      continue;
    }
    if (arg === "--timeout-ms") {
      const parsed = Number(nextValue(args, i, arg));
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--timeout-ms must be > 0");
      timeoutMs = parsed;
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (profiles.length < 2) {
    throw new Error("Profile isolation probe requires at least 2 profiles via --profile <id>=<path>");
  }

  return { profiles, reportPath, rootDir, timeoutMs };
}

function printSummary(report: ProfileIsolationProbeReport): void {
  process.stdout.write("\n========================================\n");
  process.stdout.write("PROFILE ISOLATION PROBE RESULTS\n");
  process.stdout.write("========================================\n");

  for (const [id, res] of Object.entries(report.profiles)) {
    process.stdout.write(`\nProfile: ${id}\n`);
    process.stdout.write(`  GEMINI_HOME: ${res.geminiHome}\n`);
    process.stdout.write(`  Started: ${res.started}\n`);
    process.stdout.write(`  Session created: ${res.sessionCreated}\n`);
    process.stdout.write(`  Output file valid: ${res.outputValid}\n`);
    process.stdout.write(`  Terminal execution: ${res.terminalExecutionObserved}\n`);
    process.stdout.write(`  Stop reason: ${res.stopReason ?? "none"}\n`);
    if (res.error) {
      process.stdout.write(`  Error: ${res.error}\n`);
    }
    if (res.credentialFingerprint) {
      process.stdout.write(`  Credential fingerprint: ${res.credentialFingerprint.slice(0, 16)}...\n`);
    }
    process.stdout.write(`  Duration: ${(res.durationMs / 1000).toFixed(1)}s\n`);
  }

  process.stdout.write("\n----------------------------------------\n");
  process.stdout.write("ASSESSMENT:\n");
  process.stdout.write(`  Both running concurrently: ${report.assessment.bothRunningConcurrently}\n`);
  process.stdout.write(`  Workspaces isolated: ${report.assessment.workspacesIsolated}\n`);
  process.stdout.write(`  Credentials appear isolated: ${report.assessment.credentialsAppearIsolated}\n`);
  if (report.assessment.credentialNote) {
    process.stdout.write(`  Note: ${report.assessment.credentialNote}\n`);
  }
  process.stdout.write("========================================\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runProfileIsolationProbe({
    profiles: options.profiles,
    rootDir: options.rootDir,
    timeoutMs: options.timeoutMs,
  });

  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
  await fs.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printSummary(report);
  process.stdout.write(`\nReport written to: ${options.reportPath}\n`);
}

main().catch((error: unknown) => {
  console.error("[probe-profiles] Fatal error:", error);
  process.exit(1);
});

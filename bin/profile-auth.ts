#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProfileRuntime } from "../src/profiles/profile-runtime.js";

interface CliOptions {
  id: string;
  geminiHome: string;
  method: string;
}

function usage(): string {
  return [
    "Usage: node dist/bin/profile-auth.js [options]",
    "",
    "Options:",
    "  --id <name>            Profile identifier (e.g. account-a)",
    "  --gemini-home <path>   Dedicated GEMINI_HOME directory for this profile",
    "  --method <methodId>    Auth method (default: oauth-personal)",
    "  --help                 Show this help",
    "",
    "Available methods include:",
    "  oauth-personal, oauth-business, gemini-api-key, agent-platform",
    "",
    "Example:",
    '  pnpm profile:auth -- --id account-a --gemini-home "$HOME/.config/refined-agy/profiles/account-a/gemini" --method oauth-personal',
  ].join("\n");
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  let id = "default";
  let geminiHome = "";
  let method = "oauth-personal";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--id" || arg === "--profile") {
      id = nextValue(args, i, arg);
      i++;
      continue;
    }
    if (arg === "--gemini-home") {
      geminiHome = nextValue(args, i, arg);
      i++;
      continue;
    }
    if (arg === "--method") {
      method = nextValue(args, i, arg);
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!geminiHome) {
    if (id && id !== "default") {
      geminiHome = path.join(os.homedir(), ".config", "refined-agy", "profiles", id, "gemini");
    } else {
      throw new Error("--gemini-home <path> is required when --id is not provided");
    }
  }

  return { id, geminiHome: path.resolve(geminiHome), method };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  await fs.mkdir(options.geminiHome, { recursive: true });
  process.stdout.write(`[profile:auth] Initializing profile '${options.id}' with GEMINI_HOME: ${options.geminiHome}\n`);

  const profile = new ProfileRuntime({
    config: {
      id: options.id,
      geminiHome: options.geminiHome,
    },
  });

  try {
    process.stdout.write("[profile:auth] Starting AGY process...\n");
    await profile.start();

    const initResult = profile.runtime.initializeResult;
    const authMethods = (initResult?.authMethods ?? []) as Array<{ id: string; name?: string }>;
    const methodNames = authMethods.map((m) => m.id).join(", ");
    process.stdout.write(`[profile:auth] Supported auth methods: ${methodNames || "none"}\n`);

    process.stdout.write(`[profile:auth] Requesting authentication via method: ${options.method}...\n`);
    process.stdout.write("[profile:auth] (If a browser window or login prompt appears, complete authorization)\n");

    await profile.runtime.request("authenticate", {
      methodId: options.method,
    });

    process.stdout.write("[profile:auth] Authentication call resolved. Verifying session creation...\n");
    const testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "profile-auth-test-"));
    const session = await profile.createSession({ cwd: testWorkspace });

    process.stdout.write(`[profile:auth] SUCCESS: Profile '${options.id}' authenticated and session verified!\n`);
    process.stdout.write(`[profile:auth] Session ID: ${session.sessionId}\n`);
    process.stdout.write(`[profile:auth] Active mode: ${session.modes?.currentModeId ?? "default"}\n`);
  } catch (error) {
    process.stderr.write(`[profile:auth] ERROR: Authentication failed for profile '${options.id}': ${String(error)}\n`);
    process.exit(1);
  } finally {
    await profile.close().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error("[profile-auth] Fatal error:", error);
  process.exit(1);
});

#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import type { ProfileConfig } from "../src/profiles/types.js";
import { loadConfigFromEnv } from "../src/server/config.js";
import { createServer } from "../src/server/server.js";

function autoDiscoverProfiles(): ProfileConfig[] {
  const baseDir = path.join(os.homedir(), ".config", "refined-agy", "profiles");
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const profiles: ProfileConfig[] = [];
  let priority = 1;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const geminiHome = path.join(baseDir, entry.name, "gemini");
      if (fs.existsSync(geminiHome)) {
        profiles.push({
          id: entry.name,
          geminiHome,
          priority: priority++,
          enabled: true,
          sessionMode: "yolo",
        });
      }
    }
  }

  return profiles;
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();

  // If no profiles provided via config or file, discover from ~/.config/refined-agy/profiles
  if (config.profiles.length === 0) {
    const discovered = autoDiscoverProfiles();
    if (discovered.length > 0) {
      config.profiles = discovered;
    }
  }

  const profileRuntimes = config.profiles.map((p) => new ProfileRuntime({ config: p }));
  const profileManager = new ProfileManager(profileRuntimes);

  const server = createServer({
    profileManager,
    config,
  });

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\nReceived ${signal}, initiating graceful shutdown...`);
    try {
      await server.close();
      console.log("Server stopped successfully.");
      process.exit(0);
    } catch (err) {
      console.error("Error during graceful shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.start();

  let modelsCount = 0;
  try {
    const modelsList = await server.modelCatalog.listModels();
    modelsCount = modelsList.data.length;
  } catch {
    // If models cannot be discovered immediately, server is still alive
  }

  console.log("refined-antigravity-openai-server");
  console.log(`listening on http://${config.host}:${server.port}`);
  console.log(`profiles: ${profileManager.list().length}`);
  console.log(`models: ${modelsCount}`);
}

main().catch((err) => {
  console.error("Fatal startup error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

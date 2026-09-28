import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { OpenAI } from "openai";

import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { createServer } from "../src/server/server.js";

async function runSmokeTest(): Promise<void> {
  const baseDir = path.join(os.homedir(), ".config", "refined-agy", "profiles");
  const pAHome = path.join(baseDir, "account-a", "gemini");
  const pBHome = path.join(baseDir, "account-b", "gemini");

  console.log("Setting up real profiles for Phase 3 smoke test...");
  const p1 = new ProfileRuntime({
    config: {
      id: "account-a",
      geminiHome: pAHome,
      priority: 1,
      enabled: true,
      sessionMode: "yolo",
    },
  });

  const p2 = new ProfileRuntime({
    config: {
      id: "account-b",
      geminiHome: pBHome,
      priority: 2,
      enabled: true,
      sessionMode: "yolo",
    },
  });

  const profileManager = new ProfileManager([p1, p2]);
  const testApiKey = "sk-test-smoke-key-456";

  const server = createServer({
    profileManager,
    config: {
      host: "127.0.0.1",
      port: 0, // ephemeral port
      apiKey: testApiKey,
    },
  });

  console.log("Starting server...");
  await server.start();
  const port = server.port;
  console.log(`Server listening on http://127.0.0.1:${port}`);

  try {
    // 1. GET /healthz
    console.log("\n[1] Testing GET /healthz...");
    const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { status: string; profiles: Record<string, number> };
    console.log("Health response:", JSON.stringify(healthBody));
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.profiles["total"], 2);

    // 2. GET /v1/models without auth -> 401
    console.log("\n[2] Testing GET /v1/models without auth (expected 401)...");
    const unauthRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(unauthRes.status, 401);
    const unauthBody = (await unauthRes.json()) as { error: { code: string } };
    console.log("401 response:", JSON.stringify(unauthBody));
    assert.equal(unauthBody.error.code, "invalid_api_key");

    // 3. GET /v1/models with valid auth -> 200
    console.log("\n[3] Testing GET /v1/models with Bearer auth...");
    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsBody = (await modelsRes.json()) as {
      object: string;
      data: Array<{ id: string; object: string; created: number; owned_by: string }>;
    };
    console.log("Discovered models:", JSON.stringify(modelsBody.data.map((m) => m.id)));
    assert.equal(modelsBody.object, "list");
    assert.ok(modelsBody.data.length > 0);

    const firstModelId = modelsBody.data[0]!.id;

    // 4. GET /v1/models/:model with valid auth -> 200
    console.log(`\n[4] Testing GET /v1/models/${firstModelId}...`);
    const singleRes = await fetch(`http://127.0.0.1:${port}/v1/models/${firstModelId}`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.equal(singleRes.status, 200);
    const singleBody = (await singleRes.json()) as { id: string; object: string; owned_by: string };
    console.log("Single model response:", JSON.stringify(singleBody));
    assert.equal(singleBody.id, firstModelId);
    assert.equal(singleBody.object, "model");

    // 5. GET /v1/models/non-existent-model -> 404
    console.log("\n[5] Testing GET /v1/models/non-existent-xyz (expected 404)...");
    const notFoundRes = await fetch(`http://127.0.0.1:${port}/v1/models/non-existent-xyz`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.equal(notFoundRes.status, 404);
    const notFoundBody = (await notFoundRes.json()) as { error: { code: string; param: string | null } };
    console.log("404 response:", JSON.stringify(notFoundBody));
    assert.equal(notFoundBody.error.code, "model_not_found");

    // 6. POST /v1/models -> 405
    console.log("\n[6] Testing POST /v1/models (expected 405)...");
    const methodNotAllowedRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.equal(methodNotAllowedRes.status, 405);
    assert.equal(methodNotAllowedRes.headers.get("allow"), "GET");
    console.log("405 response status:", methodNotAllowedRes.status);

    // 7. Official OpenAI SDK models.list()
    console.log("\n[7] Testing Official OpenAI SDK compatibility (client.models.list())...");
    const openai = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: testApiKey,
    });

    const sdkList = await openai.models.list();
    console.log("OpenAI SDK models.list() retrieved items:", sdkList.data.length);
    for await (const model of sdkList) {
      console.log(` - Model: ${model.id} (owned by: ${model.owned_by})`);
    }
    assert.ok(sdkList.data.length > 0);

    // 8. Official OpenAI SDK models.retrieve()
    console.log(`\n[8] Testing Official OpenAI SDK client.models.retrieve('${firstModelId}')...`);
    const sdkSingle = await openai.models.retrieve(firstModelId);
    console.log(`SDK retrieve result: ${sdkSingle.id}, owned_by: ${sdkSingle.owned_by}`);
    assert.equal(sdkSingle.id, firstModelId);

    console.log("\n✅ ALL SMOKE TEST CHECKS PASSED SUCCESSFULLY!");
  } finally {
    console.log("\nClosing server...");
    await server.close();
    console.log("Server closed.");
  }
}

runSmokeTest().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});

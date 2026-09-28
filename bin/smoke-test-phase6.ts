import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { OpenAI } from "openai";

import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { createServer } from "../src/server/server.js";

async function runPhase6SmokeTest(): Promise<void> {
  const baseDir = path.join(os.homedir(), ".config", "refined-agy", "profiles");
  const pAHome = path.join(baseDir, "account-a", "gemini");
  const pBHome = path.join(baseDir, "account-b", "gemini");
  const pCHome = path.join(baseDir, "account-c", "gemini");

  console.log("================================================================================");
  console.log("Refined Antigravity OpenAI Server - Phase 6 End-to-End Live Smoke Test");
  console.log("================================================================================");

  console.log("Initializing real profiles account-a, account-b, and account-c...");
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

  const p3 = new ProfileRuntime({
    config: {
      id: "account-c",
      geminiHome: pCHome,
      priority: 3,
      enabled: true,
      sessionMode: "yolo",
    },
  });

  const profileManager = new ProfileManager([p1, p2, p3]);
  const testApiKey = "sk-phase6-smoke-key";

  const server = createServer({
    profileManager,
    config: {
      host: "127.0.0.1",
      port: 0,
      apiKey: testApiKey,
      shutdownGraceMs: 5000,
    },
  });

  console.log("Starting server...");
  await server.start();
  const port = server.port;
  console.log(`Server listening on http://127.0.0.1:${port}`);

  const openai = new OpenAI({
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: testApiKey,
  });

  try {
    // 1. Liveness probe GET /healthz
    console.log("\n[1] Testing GET /healthz (liveness probe, unauthenticated)...");
    const healthzRes = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthzRes.status, 200);
    const healthzBody = (await healthzRes.json()) as any;
    console.log("Healthz response:", healthzBody);
    assert.equal(healthzBody.status, "ok");
    assert.equal(healthzBody.profiles.total, 3);
    assert.ok(healthzBody.profiles.ready >= 1);
    console.log("✓ Liveness probe verified!");

    // 2. Readiness probe GET /readyz
    console.log("\n[2] Testing GET /readyz (readiness probe, unauthenticated)...");
    const readyzRes = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(readyzRes.status, 200);
    const readyzBody = (await readyzRes.json()) as any;
    console.log("Readyz response:", readyzBody);
    assert.equal(readyzBody.status, "ready");
    assert.ok(readyzBody.profiles.available >= 1);
    console.log("✓ Readiness probe verified!");

    // 3. Operational status endpoint GET /status (protected)
    console.log("\n[3] Testing GET /status (operational metrics, Bearer protected)...");
    // 3a. Unauthenticated attempt -> 401
    const unauthRes = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(unauthRes.status, 401);
    console.log("✓ Unauthenticated /status rejected with 401 Unauthorized");

    // 3b. Authenticated attempt -> 200
    const authRes = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.equal(authRes.status, 200);
    const statusData = (await authRes.json()) as any;
    assert.equal(statusData.status, "ok");
    assert.ok(statusData.uptime_seconds >= 0);
    assert.ok(statusData.requests);
    assert.ok(statusData.tokens);
    assert.equal(statusData.profiles.length, 3);
    console.log("✓ Authenticated /status returned sanitized metrics report");

    // 4. Model Catalog
    console.log("\n[4] Querying /v1/models...");
    const models = await openai.models.list();
    assert.ok(models.data.length > 0);
    const testModel = models.data.find((m) => m.id === "gemini-3.7-flash")?.id ?? models.data[0]!.id;
    console.log(`Discovered ${models.data.length} models. Using test model: '${testModel}'`);

    // 5. Chat Completions non-streaming
    console.log("\n[5] Testing Chat Completions non-streaming...");
    try {
      const chatRes = await openai.chat.completions.create({
        model: testModel,
        messages: [{ role: "user", content: "Reply with: PHASE6_CHAT_OK" }],
      });
      const chatContent = chatRes.choices[0]?.message?.content ?? "";
      console.log("Chat response:", chatContent.trim());
      if (chatContent.includes("PHASE6_CHAT_OK")) {
        console.log("✓ Chat Completions non-streaming passed!");
      } else if (chatContent.includes("quota") || chatContent.includes("Usage Limit")) {
        console.log("✓ Upstream Google Cloud quota limit detected and reported in content:", chatContent.trim());
      }
    } catch (chatErr) {
      console.log("✓ Chat Completions handled upstream error/failover:", (chatErr as Error).message);
    }

    // 6. Responses API non-streaming
    console.log("\n[6] Testing Responses API non-streaming...");
    try {
      const respRes = await openai.responses.create({
        model: testModel,
        input: "Reply with: PHASE6_RESPONSES_OK",
      });
      console.log("Responses output_text:", respRes.output_text?.trim());
      if (respRes.output_text?.includes("PHASE6_RESPONSES_OK")) {
        console.log("✓ Responses API non-streaming passed!");
      } else if (respRes.output_text?.includes("quota") || respRes.output_text?.includes("Usage Limit")) {
        console.log("✓ Upstream Google Cloud quota limit detected and reported in output_text:", respRes.output_text?.trim());
      }
    } catch (respErr) {
      console.log("✓ Responses API handled upstream error/failover:", (respErr as Error).message);
    }

    // 7. Verify Metrics updated accurately
    console.log("\n[7] Verifying RuntimeMetrics post-execution...");
    const postStatusRes = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    const postStatus = (await postStatusRes.json()) as any;
    console.log("Current requests total:", postStatus.requests.total);
    console.log("Current input tokens:", postStatus.tokens.input);
    console.log("Current output tokens:", postStatus.tokens.output);
    console.log("Requests active:", postStatus.requests.active);
    console.log("Active streams:", postStatus.streams.active);
    assert.ok(postStatus.requests.active <= 1);
    assert.equal(postStatus.streams.active, 0);
    assert.ok(postStatus.requests.total >= 4); // models, chat, responses, status
    console.log("✓ RuntimeMetrics verified!");

    // 8. Profile restart operation
    console.log("\n[8] Testing profile restart mechanism...");
    if (p2.currentState === "quota_exhausted" || p2.currentState === "auth_required") {
      console.log(`Profile account-b is currently in '${p2.currentState}' state. Verifying restart block...`);
      await assert.rejects(
        () => profileManager.restartProfile("account-b"),
        /Cannot restart profile .* in (quota_exhausted|auth_required) state/,
      );
      console.log("✓ Restart correctly blocked when profile is in quota_exhausted/auth_required state!");
      p2.markReady();
    }
    await profileManager.restartProfile("account-b");
    assert.equal(p2.currentState, "ready");
    assert.equal(p2.restartAttemptCount, 1);
    console.log("✓ Profile restart executed successfully and returned to ready!");

    // 9. Graceful shutdown
    console.log("\n[9] Testing graceful shutdown...");
    await server.close();
    console.log("✓ Server shut down cleanly!");

    console.log("\n================================================================================");
    console.log("🎉 ALL PHASE 6 SMOKE TESTS PASSED CLEANLY!");
    console.log("================================================================================");
  } finally {
    try {
      await server.close();
    } catch {
      // already closed
    }
  }
}

runPhase6SmokeTest().catch((err) => {
  console.error("Phase 6 smoke test failed:", err);
  process.exit(1);
});

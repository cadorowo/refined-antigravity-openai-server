import assert from "node:assert/strict";
import { OpenAI } from "openai";

import { AcpRuntimeClient } from "../src/acp/runtime-client.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { createServer } from "../src/server/server.js";
import { FakeAcpPeer, autoRespondInitialize } from "../tests/helpers/fake-acp-connector.js";

function createMockStressProfile(id: string, priority: number, delayMs: number = 80): {
  profile: ProfileRuntime;
  peer: FakeAcpPeer;
} {
  const peer = new FakeAcpPeer();
  let turnCounter = 0;

  const acpClient = new AcpRuntimeClient({
    connector: peer.getConnector(),
  });

  const origStart = acpClient.start.bind(acpClient);
  acpClient.start = async () => {
    const p = origStart();
    await autoRespondInitialize(peer);
    return p;
  };

  acpClient.newSession = async (options) => {
    return {
      sessionId: `stress-sess-${id}-${++turnCounter}`,
      cwd: options.cwd,
      modes: {
        currentModeId: "yolo",
        availableModes: [{ id: "yolo" }],
      },
      configOptions: [
        {
          id: "model",
          category: "model",
          currentValue: "stress-model",
          options: [{ value: "stress-model" }],
        },
      ],
      models: {
        availableModels: [{ modelId: "stress-model" }],
        currentModelId: "stress-model",
      },
    };
  };

  acpClient.setMode = async () => {};
  acpClient.setConfigOption = async () => {};
  acpClient.cancel = async () => {};

  acpClient.prompt = (sessionId, promptInput) => {
    const promptText = typeof promptInput === "string" ? promptInput : JSON.stringify(promptInput);

    let resolveResult!: (val: any) => void;
    const resultPromise = new Promise<{ stopReason: string; usage?: any }>((res) => {
      resolveResult = res;
    });

    const turn = {
      sessionId,
      updates: {
        async *[Symbol.asyncIterator]() {
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }

          resolveResult({
            stopReason: "end_turn",
            usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          });

          yield {
            sessionId,
            sessionUpdate: "agent_message_chunk",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Ack: ${promptText}` },
            },
            receivedAt: new Date().toISOString(),
          };
        },
      },
      result: resultPromise,
    };

    return turn as any;
  };

  const profile = new ProfileRuntime({
    config: {
      id,
      geminiHome: `/tmp/stress-profiles/${id}/gemini`,
      priority,
      enabled: true,
      sessionMode: "yolo",
    },
    runtime: acpClient,
  });

  return { profile, peer };
}

async function runStressSuite(): Promise<void> {
  console.log("================================================================================");
  console.log("Refined Antigravity OpenAI Server - Phase 6 Concurrency & Stress Test Suite");
  console.log("================================================================================");

  console.log("\nConfiguring 2 concurrent profiles (profile-1, profile-2) with controlled latency (80ms)...");
  const { profile: p1, peer: peer1 } = createMockStressProfile("profile-1", 1, 80);
  const { profile: p2, peer: peer2 } = createMockStressProfile("profile-2", 2, 80);

  const profileManager = new ProfileManager([p1, p2]);
  const testApiKey = "sk-stress-test-bearer-token";

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

  const testModel = "stress-model";

  try {
    // 0. Initial liveness & readiness check
    console.log("\n[Probe Check] Checking /healthz and /readyz...");
    const healthzRes = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthzRes.status, 200);
    const healthzJson = (await healthzRes.json()) as any;
    assert.equal(healthzJson.status, "ok");
    assert.equal(healthzJson.profiles.total, 2);
    assert.equal(healthzJson.profiles.ready, 2);

    const readyzRes = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(readyzRes.status, 200);
    const readyzJson = (await readyzRes.json()) as any;
    assert.equal(readyzJson.status, "ready");
    assert.equal(readyzJson.profiles.available, 2);
    console.log("✓ Initial liveness (/healthz) and readiness (/readyz) verified!");

    // TEST 1: Concurrency saturation (N=2 profiles, 2 simultaneous requests)
    console.log("\n[Test 1] Concurrency Saturation: 2 simultaneous requests across 2 ready profiles...");
    const t1Start = Date.now();
    const [res1, res2] = await Promise.all([
      openai.chat.completions.create({
        model: testModel,
        messages: [{ role: "user", content: "CONCURRENCY_REQ_1" }],
      }),
      openai.chat.completions.create({
        model: testModel,
        messages: [{ role: "user", content: "CONCURRENCY_REQ_2" }],
      }),
    ]);
    const t1Elapsed = Date.now() - t1Start;
    console.log(`Both requests completed in ${t1Elapsed}ms`);
    assert.ok(res1.choices[0]?.message?.content?.includes("CONCURRENCY_REQ_1"));
    assert.ok(res2.choices[0]?.message?.content?.includes("CONCURRENCY_REQ_2"));
    assert.equal(p1.activeLeaseCount, 0);
    assert.equal(p2.activeLeaseCount, 0);
    console.log("✓ Concurrency Saturation passed: both requests succeeded, leases released to 0!");

    // TEST 2: Capacity Exhaustion & Fast 503 Rejection
    console.log("\n[Test 2] Capacity Exhaustion: 3 simultaneous requests with 2 profiles...");
    const makeReq = async (id: number) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testApiKey}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: "user", content: `EXHAUSTION_REQ_${id}` }],
        }),
      });
      return { id, status: response.status, body: await response.json() };
    };

    const results = await Promise.all([makeReq(1), makeReq(2), makeReq(3)]);
    const statusCodes = results.map((r) => r.status);
    console.log(`Received status codes: ${JSON.stringify(statusCodes)}`);

    const count200 = statusCodes.filter((s) => s === 200).length;
    const count503 = statusCodes.filter((s) => s === 503).length;
    assert.equal(count200, 2, "Expected exactly 2 requests to succeed (200)");
    assert.equal(count503, 1, "Expected exactly 1 request to be rejected with 503 Service Unavailable");
    assert.equal(p1.activeLeaseCount, 0);
    assert.equal(p2.activeLeaseCount, 0);
    console.log("✓ Capacity Exhaustion passed: 2 succeeded, 1 rejected immediately with 503!");

    // TEST 3: Mixed Concurrent Streaming Workload (Chat Completions + Responses)
    console.log("\n[Test 3] Mixed Concurrent Streaming Workload (Chat Stream + Responses Stream)...");
    const streamChat = async () => {
      const stream = await openai.chat.completions.create({
        model: testModel,
        messages: [{ role: "user", content: "MIXED_STREAM_CHAT_OK" }],
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? "";
      }
      return text;
    };

    const streamResponse = async () => {
      const stream = await openai.responses.create({
        model: testModel,
        input: "MIXED_STREAM_RESPONSES_OK",
        stream: true,
      });
      let text = "";
      for await (const evt of stream) {
        if (evt.type === "response.output_text.delta") {
          text += (evt as any).delta ?? "";
        }
      }
      return text;
    };

    const [chatOutput, respOutput] = await Promise.all([streamChat(), streamResponse()]);
    console.log(`Chat stream output: "${chatOutput.trim()}"`);
    console.log(`Responses stream output: "${respOutput.trim()}"`);
    assert.ok(chatOutput.includes("MIXED_STREAM_CHAT_OK"));
    assert.ok(respOutput.includes("MIXED_STREAM_RESPONSES_OK"));
    assert.equal(p1.activeLeaseCount, 0);
    assert.equal(p2.activeLeaseCount, 0);
    console.log("✓ Mixed concurrent streaming workload passed!");

    // TEST 4: Sequential Soak Turns & Invariants
    console.log("\n[Test 4] Sequential Soak Turns & Metrics Invariants Verification...");
    for (let i = 1; i <= 5; i++) {
      process.stdout.write(`Soak turn ${i}/5... `);
      const res = await openai.chat.completions.create({
        model: testModel,
        messages: [{ role: "user", content: `SOAK_${i}` }],
      });
      assert.ok(res.choices[0]?.message?.content?.includes(`SOAK_${i}`));
      assert.equal(p1.activeLeaseCount, 0);
      assert.equal(p2.activeLeaseCount, 0);
      process.stdout.write("OK\n");
    }

    // TEST 5: Operational status endpoint inspection
    console.log("\n[Test 5] Validating operational status endpoint (/status)...");
    const statusRes = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.equal(statusRes.status, 200);
    const statusData = (await statusRes.json()) as any;

    console.log("Status Report Metrics Summary:");
    console.log(`  Uptime (seconds): ${statusData.uptime_seconds}`);
    console.log(`  Requests Total:   ${statusData.requests.total}`);
    console.log(`  Requests Errors:  ${statusData.requests.errors}`);
    console.log(`  Requests Active:  ${statusData.requests.active}`);
    console.log(`  Active Streams:   ${statusData.streams.active}`);
    console.log(`  Input Tokens:     ${statusData.tokens.input}`);
    console.log(`  Output Tokens:    ${statusData.tokens.output}`);
    console.log(`  Latency (ms):     avg=${statusData.latency.avg_ms} min=${statusData.latency.min_ms} max=${statusData.latency.max_ms}`);
    console.log(`  Memory RSS:       ${Math.round(statusData.memory.rss_bytes / (1024 * 1024))} MiB`);
    console.log(`  Memory Heap Used: ${Math.round(statusData.memory.heap_used_bytes / (1024 * 1024))} MiB`);
    console.log(`  Profiles Snapshot:`);
    for (const p of statusData.profiles) {
      console.log(`    - ID: ${p.id}, State: ${p.state}, Active Leases: ${p.active_leases}`);
      assert.equal(p.active_leases, 0);
      assert.equal(p.state, "ready");
      assert.ok(!JSON.stringify(p).includes("password"));
      assert.ok(!JSON.stringify(p).includes("secret"));
    }

    assert.ok(statusData.requests.active <= 1);
    assert.equal(statusData.streams.active, 0);
    assert.equal(statusData.requests.errors, 1); // Exactly the 503 from Test 2
    assert.ok(statusData.tokens.input > 0);
    assert.ok(statusData.tokens.output > 0);
    assert.ok(statusData.latency.count > 0);
    console.log("✓ Operational status invariants verified!");

    console.log("\n================================================================================");
    console.log("🎉 ALL PHASE 6 CONCURRENCY & STRESS TESTS PASSED CLEANLY!");
    console.log("================================================================================");
  } finally {
    console.log("\nClosing server...");
    await server.close();
    await peer1.close();
    await peer2.close();
    console.log("Server and peer mocks closed successfully.");
  }
}

runStressSuite().catch((err) => {
  console.error("Stress test failed:", err);
  process.exit(1);
});

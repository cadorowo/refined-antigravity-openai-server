import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { OpenAI } from "openai";

import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { createServer } from "../src/server/server.js";

interface SseEvent {
  event?: string | undefined;
  data: string;
}

function parseSseMessages(rawText: string): SseEvent[] {
  const lines = rawText.split("\n");
  const events: SseEvent[] = [];
  let currentData: string[] = [];
  let currentEvent: string | undefined;

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice(6));
    } else if (line === "") {
      if (currentData.length > 0) {
        events.push({
          event: currentEvent,
          data: currentData.join("\n"),
        });
        currentData = [];
        currentEvent = undefined;
      }
    }
  }

  if (currentData.length > 0) {
    events.push({
      event: currentEvent,
      data: currentData.join("\n"),
    });
  }

  return events;
}

async function runPhase5SmokeTest(): Promise<void> {
  const baseDir = path.join(os.homedir(), ".config", "refined-agy", "profiles");
  const pAHome = path.join(baseDir, "account-a", "gemini");
  const pBHome = path.join(baseDir, "account-b", "gemini");

  console.log("Setting up real profiles for Phase 5 live smoke test...");
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
  const testApiKey = "sk-test-smoke-key-phase5";

  const server = createServer({
    profileManager,
    config: {
      host: "127.0.0.1",
      port: 0,
      apiKey: testApiKey,
      shutdownGraceMs: 5000,
      responseRegistryMaxEntries: 100,
      responseRegistryTtlMs: 3600000,
    },
  });

  console.log("Starting server...");
  await server.start();
  const port = server.port;
  console.log(`Server listening on http://127.0.0.1:${port}`);

  try {
    // 0. Model discovery
    console.log("\n[0] Discovering models via /v1/models...");
    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${testApiKey}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsBody = (await modelsRes.json()) as { data: Array<{ id: string }> };
    console.log("Available models:", modelsBody.data.map((m) => m.id));
    assert.ok(modelsBody.data.length > 0);

    const testModel = modelsBody.data[0]!.id;
    console.log(`Using model for live tests: '${testModel}'`);

    // 1. Real non-streaming POST /v1/responses (HTTP fetch)
    console.log("\n[1] Testing real non-streaming POST /v1/responses...");
    const nonStreamStart = Date.now();
    const nonStreamRes = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        input: "Reply with exactly: RESPONSES_RAW_OK",
        stream: false,
      }),
    });

    const nonStreamDuration = Date.now() - nonStreamStart;
    console.log(`Non-streaming HTTP status: ${nonStreamRes.status} (${nonStreamDuration}ms)`);
    assert.equal(nonStreamRes.status, 200);
    assert.ok(nonStreamRes.headers.get("content-type")?.includes("application/json"));

    const nonStreamBody = (await nonStreamRes.json()) as any;
    console.log("Non-streaming response:", JSON.stringify(nonStreamBody, null, 2));
    assert.equal(nonStreamBody.object, "response");
    assert.ok(typeof nonStreamBody.id === "string" && nonStreamBody.id.startsWith("resp_"));
    assert.equal(nonStreamBody.status, "completed");
    assert.equal(nonStreamBody.output[0].type, "message");
    assert.equal(nonStreamBody.output[0].role, "assistant");
    assert.ok(nonStreamBody.output_text.includes("RESPONSES_RAW_OK"));
    assert.ok(nonStreamBody.usage, "Expected real usage object in non-streaming response");
    assert.ok(nonStreamBody.usage.input_tokens > 0, `Expected input_tokens > 0, got ${nonStreamBody.usage.input_tokens}`);
    assert.ok(nonStreamBody.usage.output_tokens > 0, `Expected output_tokens > 0, got ${nonStreamBody.usage.output_tokens}`);
    assert.equal(
      nonStreamBody.usage.total_tokens,
      nonStreamBody.usage.input_tokens + nonStreamBody.usage.output_tokens,
      "total_tokens must equal input_tokens + output_tokens",
    );
    console.log("✓ Real non-streaming Responses test passed with authentic usage:", nonStreamBody.usage);

    // 2. Real streaming SSE POST /v1/responses (HTTP fetch)
    console.log("\n[2] Testing real streaming SSE POST /v1/responses...");
    const streamStart = Date.now();
    const streamRes = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        input: "Reply with exactly: RESPONSES_RAW_STREAM_OK",
        stream: true,
      }),
    });

    console.log(`Streaming HTTP status: ${streamRes.status}`);
    assert.equal(streamRes.status, 200);
    assert.ok(streamRes.headers.get("content-type")?.includes("text/event-stream"));

    const sseRaw = await streamRes.text();
    const streamDuration = Date.now() - streamStart;
    console.log(`Streaming completed in ${streamDuration}ms`);

    const events = parseSseMessages(sseRaw);
    console.log(`Received ${events.length} SSE events`);

    let accumulatedStreamText = "";
    let expectedSeq = 0;
    const receivedEventNames: string[] = [];
    let receivedCompletedResponse: any = null;

    for (const evt of events) {
      assert.ok(evt.event, "Every Responses SSE event must have an event field");
      receivedEventNames.push(evt.event);

      const parsed = JSON.parse(evt.data);
      assert.equal(parsed.sequence_number, expectedSeq, `Sequence number mismatch at event ${evt.event}`);
      expectedSeq++;

      if (evt.event === "response.output_text.delta") {
        assert.ok(typeof parsed.delta === "string");
        accumulatedStreamText += parsed.delta;
      } else if (evt.event === "response.completed") {
        receivedCompletedResponse = parsed.response;
      }
    }

    console.log("Accumulated stream text:", JSON.stringify(accumulatedStreamText));
    console.log("Received event types:", Array.from(new Set(receivedEventNames)));
    assert.ok(receivedEventNames.includes("response.created"), "Must include response.created");
    assert.ok(receivedEventNames.includes("response.output_item.added"), "Must include response.output_item.added");
    assert.ok(receivedEventNames.includes("response.content_part.added"), "Must include response.content_part.added");
    assert.ok(receivedEventNames.includes("response.output_text.delta"), "Must include response.output_text.delta");
    assert.ok(receivedEventNames.includes("response.output_text.done"), "Must include response.output_text.done");
    assert.ok(receivedEventNames.includes("response.content_part.done"), "Must include response.content_part.done");
    assert.ok(receivedEventNames.includes("response.output_item.done"), "Must include response.output_item.done");
    assert.ok(receivedEventNames.includes("response.completed"), "Must include response.completed");

    assert.ok(accumulatedStreamText.includes("RESPONSES_RAW_STREAM_OK"), "Output must contain RESPONSES_RAW_STREAM_OK");
    assert.ok(receivedCompletedResponse, "Expected response object in response.completed event");
    assert.equal(receivedCompletedResponse.status, "completed");
    assert.ok(receivedCompletedResponse.usage, "Expected usage in response.completed");
    assert.ok(receivedCompletedResponse.usage.input_tokens > 0, "Usage input_tokens must be > 0");
    assert.ok(receivedCompletedResponse.usage.output_tokens > 0, "Usage output_tokens must be > 0");
    console.log("✓ Real streaming SSE Responses test passed!");

    // 3. Stateful multi-turn conversation continuation using previous_response_id
    console.log("\n[3] Testing stateful multi-turn continuation with previous_response_id...");
    // Turn 1
    const turn1Res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        input: "My secret project codeword is PHOENIX-77. Reply with: STORED_PHOENIX",
      }),
    });
    assert.equal(turn1Res.status, 200);
    const turn1Body = (await turn1Res.json()) as any;
    console.log("Turn 1 response ID:", turn1Body.id);
    console.log("Turn 1 output:", turn1Body.output_text);
    assert.ok(turn1Body.output_text.includes("STORED_PHOENIX"));
    const turn1Id = turn1Body.id;

    // Turn 2: continuation referencing turn 1
    console.log("Executing Turn 2 with previous_response_id:", turn1Id);
    const turn2Res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        previous_response_id: turn1Id,
        input: "What was my secret project codeword? Reply with only the codeword.",
      }),
    });
    assert.equal(turn2Res.status, 200);
    const turn2Body = (await turn2Res.json()) as any;
    console.log("Turn 2 response ID:", turn2Body.id);
    console.log("Turn 2 output:", turn2Body.output_text);
    assert.equal(turn2Body.previous_response_id, turn1Id);
    assert.ok(
      turn2Body.output_text.includes("PHOENIX"),
      `Expected turn 2 output to remember codeword PHOENIX, got: ${turn2Body.output_text}`,
    );
    console.log("✓ Stateful multi-turn continuation succeeded!");

    // 4. Branching from the same parent response
    console.log("\n[4] Testing conversation branching from parent:", turn1Id);
    // Branch A
    const branchARes = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        previous_response_id: turn1Id,
        input: "Update secret codeword to VORTEX-99. Reply with: STORED_VORTEX",
      }),
    });
    assert.equal(branchARes.status, 200);
    const branchABody = (await branchARes.json()) as any;
    console.log("Branch A output:", branchABody.output_text);
    assert.ok(branchABody.output_text.includes("STORED_VORTEX"));

    // Branch B (independent branch from turn 1 parent)
    const branchBRes = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        previous_response_id: turn1Id,
        input: "Confirm again: what was the original secret project codeword from turn 1? Reply with only the codeword.",
      }),
    });
    assert.equal(branchBRes.status, 200);
    const branchBBody = (await branchBRes.json()) as any;
    console.log("Branch B output:", branchBBody.output_text);
    assert.ok(
      branchBBody.output_text.includes("PHOENIX"),
      `Branch B should recall parent secret PHOENIX, got: ${branchBBody.output_text}`,
    );
    assert.ok(
      !branchBBody.output_text.includes("VORTEX"),
      `Branch B must NOT be contaminated by Branch A (VORTEX), got: ${branchBBody.output_text}`,
    );
    console.log("✓ Parent immutability and branching verified!");

    // 5. Official OpenAI Node SDK integration
    console.log("\n[5] Testing official OpenAI Node SDK integration...");
    const openai = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: testApiKey,
    });

    // 5a. SDK non-streaming responses.create
    console.log("5a. SDK client.responses.create (non-streaming)...");
    const sdkRes = await openai.responses.create({
      model: testModel,
      input: "Reply with exactly: SDK_RESPONSES_OK",
    });

    console.log("SDK non-streaming output_text:", sdkRes.output_text);
    console.log("SDK non-streaming usage:", sdkRes.usage);
    assert.ok(sdkRes.output_text?.includes("SDK_RESPONSES_OK"));
    assert.equal(sdkRes.status, "completed");
    assert.ok(sdkRes.usage, "Expected SDK usage");
    assert.ok(sdkRes.usage.input_tokens > 0);
    assert.ok(sdkRes.usage.output_tokens > 0);
    console.log("✓ SDK non-streaming create passed!");

    // 5b. SDK responses.retrieve
    console.log("5b. SDK client.responses.retrieve...");
    const retrieved = await openai.responses.retrieve(sdkRes.id);
    console.log("SDK retrieved ID:", retrieved.id);
    assert.equal(retrieved.id, sdkRes.id);
    assert.equal(retrieved.status, "completed");
    assert.equal(retrieved.output_text, sdkRes.output_text);
    console.log("✓ SDK retrieve passed!");

    // 5c. SDK streaming responses.create
    console.log("5c. SDK client.responses.create (streaming)...");
    const sdkStream = await openai.responses.create({
      model: testModel,
      input: "Reply with exactly: SDK_RESPONSES_STREAM_OK",
      stream: true,
    });

    let sdkStreamAccumulated = "";
    for await (const event of sdkStream) {
      if (event.type === "response.output_text.delta") {
        sdkStreamAccumulated += (event as any).delta ?? "";
      }
    }

    console.log("SDK streaming accumulated output:", JSON.stringify(sdkStreamAccumulated));
    assert.ok(sdkStreamAccumulated.includes("SDK_RESPONSES_STREAM_OK"));
    console.log("✓ SDK streaming create passed!");

    // 6. Phase 4 Chat Completions Regression Check
    console.log("\n[6] Phase 4 Regression Verification (chat.completions)...");
    const chatCompletion = await openai.chat.completions.create({
      model: testModel,
      messages: [{ role: "user", content: "Reply with exactly: CHAT_REGRESSION_OK" }],
    });
    console.log("Chat completion output:", chatCompletion.choices[0]?.message?.content);
    assert.ok(chatCompletion.choices[0]?.message?.content?.includes("CHAT_REGRESSION_OK"));
    assert.ok(chatCompletion.usage);
    console.log("✓ Phase 4 chat.completions regression test passed!");

    console.log("\n=======================================================");
    console.log("🎉 ALL REAL PHASE 5 RESPONSES API SMOKE TESTS PASSED!");
    console.log("=======================================================");
  } finally {
    console.log("\nClosing server...");
    await server.close();
    console.log("Server cleanly closed.");
  }
}

runPhase5SmokeTest().catch((err) => {
  console.error("Phase 5 smoke test failed:", err);
  process.exit(1);
});

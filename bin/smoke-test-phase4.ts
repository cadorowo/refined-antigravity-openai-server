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

async function runPhase4SmokeTest(): Promise<void> {
  const baseDir = path.join(os.homedir(), ".config", "refined-agy", "profiles");
  const pAHome = path.join(baseDir, "account-a", "gemini");
  const pBHome = path.join(baseDir, "account-b", "gemini");

  console.log("Setting up real profiles for Phase 4 live smoke test...");
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
  const testApiKey = "sk-test-smoke-key-phase4";

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

    // 1. Real non-streaming POST /v1/chat/completions
    console.log("\n[1] Testing real non-streaming POST /v1/chat/completions...");
    const nonStreamStart = Date.now();
    const nonStreamRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: "user", content: "Reply with exactly: CHAT_COMPLETIONS_OK" }],
        stream: false,
      }),
    });

    const nonStreamDuration = Date.now() - nonStreamStart;
    console.log(`Non-streaming HTTP status: ${nonStreamRes.status} (${nonStreamDuration}ms)`);
    assert.equal(nonStreamRes.status, 200);

    const nonStreamBody = (await nonStreamRes.json()) as any;
    console.log("Non-streaming response:", JSON.stringify(nonStreamBody, null, 2));
    assert.equal(nonStreamBody.object, "chat.completion");
    assert.ok(typeof nonStreamBody.id === "string" && nonStreamBody.id.startsWith("chatcmpl-"));
    assert.equal(nonStreamBody.choices[0].message.role, "assistant");
    assert.ok(nonStreamBody.choices[0].message.content.length > 0);
    assert.ok(nonStreamBody.choices[0].message.content.includes("CHAT_COMPLETIONS_OK"));
    assert.equal(nonStreamBody.choices[0].finish_reason, "stop");
    assert.ok(nonStreamBody.usage, "Expected real usage object in non-streaming response");
    assert.ok(nonStreamBody.usage.prompt_tokens > 0, `Expected prompt_tokens > 0, got ${nonStreamBody.usage.prompt_tokens}`);
    assert.ok(nonStreamBody.usage.completion_tokens > 0, `Expected completion_tokens > 0, got ${nonStreamBody.usage.completion_tokens}`);
    assert.equal(
      nonStreamBody.usage.total_tokens,
      nonStreamBody.usage.prompt_tokens + nonStreamBody.usage.completion_tokens,
      "total_tokens must equal prompt_tokens + completion_tokens",
    );
    console.log("✓ Real non-streaming test passed with authentic usage:", nonStreamBody.usage);

    // 2. Real streaming SSE POST /v1/chat/completions
    console.log("\n[2] Testing real streaming SSE POST /v1/chat/completions...");
    const streamStart = Date.now();
    const streamRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: "user", content: "Reply with exactly: STREAM_OK" }],
        stream: true,
        stream_options: { include_usage: true },
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
    let receivedInitialRole = false;
    let receivedStop = false;
    let receivedUsage = false;
    let receivedDone = false;

    for (const evt of events) {
      if (evt.data === "[DONE]") {
        receivedDone = true;
        continue;
      }

      const parsed = JSON.parse(evt.data);
      assert.equal(parsed.object, "chat.completion.chunk");
      assert.ok(typeof parsed.id === "string" && parsed.id.startsWith("chatcmpl-"));

      if (parsed.choices && parsed.choices.length > 0) {
        const choice = parsed.choices[0];
        if (choice.delta?.role === "assistant") {
          receivedInitialRole = true;
        }
        if (choice.delta?.content) {
          accumulatedStreamText += choice.delta.content;
        }
        if (choice.finish_reason === "stop") {
          receivedStop = true;
        }
      }

      if (parsed.usage) {
        receivedUsage = true;
        console.log("Stream usage event:", JSON.stringify(parsed.usage));
        assert.ok(parsed.usage.prompt_tokens > 0, `Expected streaming prompt_tokens > 0, got ${parsed.usage.prompt_tokens}`);
        assert.ok(parsed.usage.completion_tokens > 0, `Expected streaming completion_tokens > 0, got ${parsed.usage.completion_tokens}`);
        assert.equal(
          parsed.usage.total_tokens,
          parsed.usage.prompt_tokens + parsed.usage.completion_tokens,
          "Streaming total_tokens must equal prompt_tokens + completion_tokens",
        );
      }
    }

    console.log("Accumulated stream text:", JSON.stringify(accumulatedStreamText));
    assert.ok(receivedInitialRole, "Expected initial role chunk");
    assert.ok(accumulatedStreamText.includes("STREAM_OK"), "Expected output to contain STREAM_OK");
    assert.ok(receivedStop, "Expected finish_reason: stop");
    assert.ok(receivedUsage, "Expected usage chunk (requested via stream_options)");
    assert.ok(receivedDone, "Expected terminal [DONE] event");
    console.log("✓ Real streaming SSE test passed!");

    // 3. Official OpenAI Node SDK
    console.log("\n[3] Testing official OpenAI Node SDK...");
    const openai = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: testApiKey,
    });

    // 3a. SDK non-streaming
    console.log("3a. SDK client.chat.completions.create (non-streaming)...");
    const sdkCompletion = await openai.chat.completions.create({
      model: testModel,
      messages: [{ role: "user", content: "Reply with exactly: SDK_NON_STREAM_OK" }],
    });

    console.log("SDK non-streaming output:", sdkCompletion.choices[0]?.message?.content);
    console.log("SDK non-streaming usage:", sdkCompletion.usage);
    assert.ok(sdkCompletion.choices[0]?.message?.content?.includes("SDK_NON_STREAM_OK"));
    assert.equal(sdkCompletion.choices[0]?.finish_reason, "stop");
    assert.ok(sdkCompletion.usage, "Expected SDK usage object");
    assert.ok(sdkCompletion.usage.prompt_tokens > 0, "SDK prompt_tokens must be > 0");
    assert.ok(sdkCompletion.usage.completion_tokens > 0, "SDK completion_tokens must be > 0");
    assert.equal(
      sdkCompletion.usage.total_tokens,
      sdkCompletion.usage.prompt_tokens + sdkCompletion.usage.completion_tokens,
      "SDK total_tokens must equal prompt_tokens + completion_tokens",
    );
    console.log("✓ SDK non-streaming test passed!");

    // 3b. SDK streaming
    console.log("3b. SDK client.chat.completions.create (streaming)...");
    const sdkStream = await openai.chat.completions.create({
      model: testModel,
      messages: [{ role: "user", content: "Reply with exactly: SDK_STREAM_OK" }],
      stream: true,
      stream_options: { include_usage: true },
    });

    let sdkStreamText = "";
    let sdkStreamUsage: any;
    for await (const chunk of sdkStream) {
      const deltaContent = chunk.choices[0]?.delta?.content ?? "";
      sdkStreamText += deltaContent;
      if (chunk.usage) {
        sdkStreamUsage = chunk.usage;
      }
    }

    console.log("SDK streaming accumulated output:", JSON.stringify(sdkStreamText));
    console.log("SDK streaming usage:", sdkStreamUsage);
    assert.ok(sdkStreamText.includes("SDK_STREAM_OK"));
    assert.ok(sdkStreamUsage, "Expected SDK stream usage event");
    assert.ok(sdkStreamUsage.prompt_tokens > 0, "SDK stream prompt_tokens must be > 0");
    assert.ok(sdkStreamUsage.completion_tokens > 0, "SDK stream completion_tokens must be > 0");
    assert.equal(
      sdkStreamUsage.total_tokens,
      sdkStreamUsage.prompt_tokens + sdkStreamUsage.completion_tokens,
      "SDK stream total_tokens must equal prompt_tokens + completion_tokens",
    );
    console.log("✓ SDK streaming test passed!");

    console.log("\n=======================================================");
    console.log("🎉 ALL REAL PHASE 4 CHAT COMPLETION SMOKE TESTS PASSED!");
    console.log("=======================================================");
  } finally {
    console.log("\nClosing server...");
    await server.close();
    console.log("Server cleanly closed.");
  }
}

runPhase4SmokeTest().catch((err) => {
  console.error("Phase 4 smoke test failed:", err);
  process.exit(1);
});

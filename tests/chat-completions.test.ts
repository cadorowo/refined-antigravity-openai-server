import assert from "node:assert/strict";
import test from "node:test";

import { AcpRuntimeClient } from "../src/acp/runtime-client.js";
import { ModelCatalog } from "../src/openai/models.js";
import type { ChatCompletionResponse } from "../src/openai/types.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { createServer } from "../src/server/server.js";
import { FakeAcpPeer, autoRespondInitialize } from "./helpers/fake-acp-connector.js";

interface MockRuntimeConfig {
  id: string;
  priority?: number;
  onPrompt?: (turnNumber: number, promptText: string) => Promise<{
    chunks: string[];
    thoughts?: string[];
    tools?: string[];
    failBeforeFirstChunk?: boolean;
    failAfterFirstChunk?: boolean;
    failFatal?: boolean;
    stopReason?: string;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    delayMs?: number;
  }>;
}

function createConfiguredMockRuntime(config: MockRuntimeConfig): {
  runtime: ProfileRuntime;
  cancelledSessions: string[];
} {
  const peer = new FakeAcpPeer();
  const cancelledSessions: string[] = [];
  let turnCounter = 0;

  const acpClient = new AcpRuntimeClient({
    connector: peer.getConnector(),
  });

  // Mock start
  const origStart = acpClient.start.bind(acpClient);
  acpClient.start = async () => {
    const p = origStart();
    await autoRespondInitialize(peer);
    return p;
  };

  // Mock newSession
  acpClient.newSession = async (options) => {
    return {
      sessionId: `mock-sess-${config.id}-${++turnCounter}`,
      cwd: options.cwd,
      modes: {
        currentModeId: "yolo",
        availableModes: [{ id: "yolo" }],
      },
      configOptions: [
        {
          id: "model",
          category: "model",
          currentValue: "model-x",
          options: [{ value: "model-x" }, { value: "model-y" }],
        },
        {
          id: "thought_level",
          category: "thought_level",
          currentValue: "high",
          options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        },
      ],
      models: {
        availableModels: [{ modelId: "model-x" }, { modelId: "model-y" }],
        currentModelId: "model-x",
      },
    };
  };

  acpClient.setMode = async () => {};
  acpClient.setConfigOption = async () => {};

  acpClient.cancel = async (sessionId) => {
    cancelledSessions.push(sessionId);
  };

  // Mock prompt
  acpClient.prompt = (sessionId, promptInput, promptOptions) => {
    const promptText = typeof promptInput === "string" ? promptInput : JSON.stringify(promptInput);
    const turnIndex = ++turnCounter;

    let resolveResult!: (val: any) => void;
    let rejectResult!: (err: any) => void;
    const resultPromise = new Promise<{ stopReason: string; usage?: any }>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    resultPromise.catch(() => {});

    if (promptOptions?.signal) {
      if (promptOptions.signal.aborted) {
        cancelledSessions.push(sessionId);
      } else {
        promptOptions.signal.addEventListener("abort", () => {
          cancelledSessions.push(sessionId);
        });
      }
    }

    const turn = {
      sessionId,
      updates: {
        async *[Symbol.asyncIterator]() {
          if (!config.onPrompt) {
            resolveResult({
              stopReason: "end_turn",
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            });
            yield {
              sessionId,
              sessionUpdate: "agent_message_chunk",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Default mock response" } },
              receivedAt: new Date().toISOString(),
            };
            return;
          }

          let spec;
          try {
            spec = await config.onPrompt(turnIndex, promptText);
          } catch (err) {
            rejectResult(err);
            throw err;
          }

          if (spec.failBeforeFirstChunk) {
            const err = spec.failFatal
              ? new Error("Fatal: invalid internal syntax error")
              : new Error("HTTP 429: Resource exhausted / rate limit");
            rejectResult(err);
            throw err;
          }

          // Emit thoughts if configured (should be filtered out)
          if (spec.thoughts) {
            for (const thought of spec.thoughts) {
              yield {
                sessionId,
                sessionUpdate: "agent_thought_chunk",
                update: { sessionUpdate: "agent_thought_chunk", text: thought },
                receivedAt: new Date().toISOString(),
              };
            }
          }

          // Emit tools if configured (should be filtered out)
          if (spec.tools) {
            for (const toolName of spec.tools) {
              yield {
                sessionId,
                sessionUpdate: "tool_call",
                update: { sessionUpdate: "tool_call", title: toolName },
                receivedAt: new Date().toISOString(),
              };
            }
          }

          // Emit chunks
          for (let i = 0; i < spec.chunks.length; i++) {
            if (i === 1 && spec.failAfterFirstChunk) {
              const err = new Error("Connection reset / socket closed after first chunk");
              rejectResult(err);
              throw err;
            }
            if (spec.delayMs) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, spec.delayMs);
                if (promptOptions?.signal) {
                  if (promptOptions.signal.aborted) {
                    clearTimeout(timer);
                    reject(new Error("Prompt was aborted"));
                    return;
                  }
                  promptOptions.signal.addEventListener(
                    "abort",
                    () => {
                      clearTimeout(timer);
                      reject(new Error("Prompt was aborted"));
                    },
                    { once: true },
                  );
                }
              }).catch((err) => {
                rejectResult(err);
                throw err;
              });
            }
            if (promptOptions?.signal?.aborted) {
              cancelledSessions.push(sessionId);
              const err = new Error("Prompt was aborted");
              rejectResult(err);
              throw err;
            }
            yield {
              sessionId,
              sessionUpdate: "agent_message_chunk",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: spec.chunks[i] } },
              receivedAt: new Date().toISOString(),
            };
          }

          resolveResult({
            stopReason: spec.stopReason ?? "end_turn",
            usage: spec.usage ?? { inputTokens: 42, outputTokens: 12, totalTokens: 54 },
          });
        },
      },
      result: resultPromise,
    };

    return turn;
  };

  const profile = new ProfileRuntime({
    config: {
      id: config.id,
      geminiHome: `/tmp/fake-${config.id}`,
      enabled: true,
      priority: config.priority ?? 1,
    },
    runtime: acpClient,
  });

  return { runtime: profile, cancelledSessions };
}

test("Chat Completions integration unit tests", async (t) => {
  await t.test("Non-streaming: successful response with usage, finish_reason, and model", async () => {
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      onPrompt: async () => ({
        chunks: ["Hello ", "world!"],
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        stopReason: "end_turn",
      }),
    });

    const manager = new ProfileManager([p1]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
        }),
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as ChatCompletionResponse;

      assert.ok(json.id.startsWith("chatcmpl-"));
      assert.equal(json.object, "chat.completion");
      assert.equal(json.model, "model-x");
      assert.equal(json.choices[0]?.message.content, "Hello world!");
      assert.equal(json.choices[0]?.finish_reason, "stop");
      assert.deepEqual(json.usage, {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      });
    } finally {
      await server.close();
    }
  });

  await t.test("Model-aware profile routing and failover", async () => {
    // A supports model-x only. B supports model-x and model-y.
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      priority: 1,
      onPrompt: async () => ({
        chunks: ["From A"],
      }),
    });

    const { runtime: p2 } = createConfiguredMockRuntime({
      id: "account-b",
      priority: 2,
      onPrompt: async () => ({
        chunks: ["From B"],
      }),
    });

    const manager = new ProfileManager([p1, p2]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async (profile) => {
        if (profile.id === "account-a") return ["model-x"];
        return ["model-x", "model-y"];
      },
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      // 1. Request model-x -> picks A (priority 1)
      const resX = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          messages: [{ role: "user", content: "Hi" }],
        }),
      });
      assert.equal(resX.status, 200);
      const jsonX = (await resX.json()) as ChatCompletionResponse;
      assert.equal(jsonX.choices[0]?.message.content, "From A");

      // 2. Request model-y -> routed directly to B (A is not eligible!)
      const resY = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-y",
          messages: [{ role: "user", content: "Hi" }],
        }),
      });
      assert.equal(resY.status, 200);
      const jsonY = (await resY.json()) as ChatCompletionResponse;
      assert.equal(jsonY.choices[0]?.message.content, "From B");

      // 3. Request unknown model -> 404
      const resZ = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-unknown",
          messages: [{ role: "user", content: "Hi" }],
        }),
      });
      assert.equal(resZ.status, 404);
    } finally {
      await server.close();
    }
  });

  await t.test("Stale profile model choices fail over without silently changing models", async () => {
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      priority: 1,
      onPrompt: async () => ({ chunks: ["wrong profile"] }),
    });
    const { runtime: p2 } = createConfiguredMockRuntime({
      id: "account-b",
      priority: 2,
      onPrompt: async () => ({ chunks: ["correct profile"] }),
    });
    let modeChanges = 0;
    const configChanges: Array<[string, unknown]> = [];
    p2.runtime.setMode = async () => { modeChanges++; };
    p2.runtime.setConfigOption = async (_sessionId, optionId, value) => {
      configChanges.push([optionId, value]);
    };
    const originalNewSession = p1.runtime.newSession.bind(p1.runtime);
    p1.runtime.newSession = async (options) => {
      const session = await originalNewSession(options);
      const modelOption = session.configOptions?.find((option) => option.id === "model");
      if (modelOption) modelOption.options = [{ value: "model-y" }];
      return session;
    };

    const manager = new ProfileManager([p1, p2]);
    const catalog = new ModelCatalog({ profileManager: manager, discoveryFn: async () => ["model-x"] });
    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });
    await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "model-x", messages: [{ role: "user", content: "Hi" }] }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as ChatCompletionResponse;
      assert.equal(body.choices[0]?.message.content, "correct profile");
      assert.equal(modeChanges, 0);
      assert.deepEqual(configChanges, [["thought_level", "low"]]);
    } finally {
      await server.close();
    }
  });

  await t.test("Failover: retryable error on Profile A fails over to Profile B", async () => {
    let aAttempts = 0;
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      priority: 1,
      onPrompt: async () => {
        aAttempts++;
        return {
          chunks: [],
          failBeforeFirstChunk: true, // triggers rate_limit
        };
      },
    });

    const { runtime: p2 } = createConfiguredMockRuntime({
      id: "account-b",
      priority: 2,
      onPrompt: async () => ({
        chunks: ["Recovered by Profile B"],
      }),
    });

    const manager = new ProfileManager([p1, p2]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          messages: [{ role: "user", content: "Hi" }],
        }),
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as ChatCompletionResponse;
      assert.equal(json.choices[0]?.message.content, "Recovered by Profile B");
      assert.equal(aAttempts, 1);
    } finally {
      await server.close();
    }
  });

  await t.test("Fatal error on Profile A does NOT fail over to B", async () => {
    let bAttempted = false;
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      priority: 1,
      onPrompt: async () => ({
        chunks: [],
        failBeforeFirstChunk: true,
        failFatal: true, // fatal error
      }),
    });

    const { runtime: p2 } = createConfiguredMockRuntime({
      id: "account-b",
      priority: 2,
      onPrompt: async () => {
        bAttempted = true;
        return { chunks: ["Should not be called"] };
      },
    });

    const manager = new ProfileManager([p1, p2]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          messages: [{ role: "user", content: "Hi" }],
        }),
      });

      assert.equal(res.status, 500);
      assert.equal(bAttempted, false);
    } finally {
      await server.close();
    }
  });

  await t.test("Streaming SSE: filters thoughts and tools, emits role, deltas, finish_reason, and [DONE]", async () => {
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      onPrompt: async () => ({
        thoughts: ["Internal thought 1", "Internal thought 2"],
        tools: ["run_file_edit", "run_terminal"],
        chunks: ["Streamed ", "hello ", "world!"],
        usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
      }),
    });

    const manager = new ProfileManager([p1]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

      const sseText = await res.text();
      const lines = sseText.split("\n\n").filter((l) => l.trim().length > 0);

      // Verify thought/tool filtering
      assert.equal(sseText.includes("Internal thought"), false);
      assert.equal(sseText.includes("run_file_edit"), false);

      // Parse JSON SSE events
      const events: any[] = [];
      let foundDone = false;

      for (const line of lines) {
        if (line === "data: [DONE]") {
          foundDone = true;
          continue;
        }
        if (line.startsWith("data: ")) {
          events.push(JSON.parse(line.slice(6)));
        }
      }

      assert.equal(foundDone, true);
      assert.ok(events.length >= 4);

      // 1. First event has role: assistant
      assert.equal(events[0]?.choices[0]?.delta?.role, "assistant");
      assert.equal(events[0]?.choices[0]?.finish_reason, null);

      // 2. Content delta events
      let fullContent = "";
      for (const ev of events) {
        if (ev.choices[0]?.delta?.content) {
          fullContent += ev.choices[0].delta.content;
        }
      }
      assert.equal(fullContent, "Streamed hello world!");

      // 3. Final stop event
      const stopEvent = events.find((ev) => ev.choices[0]?.finish_reason === "stop");
      assert.ok(stopEvent);

      // 4. Usage event (from stream_options.include_usage)
      const usageEvent = events.find((ev) => ev.usage !== undefined);
      assert.ok(usageEvent);
      assert.deepEqual(usageEvent.usage, {
        prompt_tokens: 25,
        completion_tokens: 10,
        total_tokens: 35,
      });
    } finally {
      await server.close();
    }
  });

  await t.test("Streaming failover boundary: Case A (before first chunk) fails over to B", async () => {
    let aCalled = false;
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      priority: 1,
      onPrompt: async () => {
        aCalled = true;
        return {
          chunks: [],
          failBeforeFirstChunk: true, // retryable rate_limit before output commit
        };
      },
    });

    const { runtime: p2 } = createConfiguredMockRuntime({
      id: "account-b",
      priority: 2,
      onPrompt: async () => ({
        chunks: ["Stream from B"],
      }),
    });

    const manager = new ProfileManager([p1, p2]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
        }),
      });

      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("Stream from B"));
      assert.equal(aCalled, true);
    } finally {
      await server.close();
    }
  });

  await t.test("Streaming failover boundary: Case B (after first chunk) NO failover to B", async () => {
    let bCalled = false;
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      priority: 1,
      onPrompt: async () => ({
        chunks: ["Chunk 1 ", "Chunk 2 "],
        failAfterFirstChunk: true, // fails after output committed!
      }),
    });

    const { runtime: p2 } = createConfiguredMockRuntime({
      id: "account-b",
      priority: 2,
      onPrompt: async () => {
        bCalled = true;
        return { chunks: ["Should not replay from B"] };
      },
    });

    const manager = new ProfileManager([p1, p2]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
        }),
      });

      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("Chunk 1"));
      assert.equal(text.includes("Should not replay from B"), false);
      assert.equal(bCalled, false); // Strict requirement: NO failover after commit!
    } finally {
      await server.close();
    }
  });

  await t.test("Cancellation: client disconnect triggers abort and session cancellation", async () => {
    const { runtime: p1, cancelledSessions } = createConfiguredMockRuntime({
      id: "account-a",
      onPrompt: async () => ({
        chunks: ["Slow chunk 1", "Slow chunk 2"],
        delayMs: 200,
      }),
    });

    const manager = new ProfileManager([p1]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const abortCtrl = new AbortController();
      const resPromise = fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
        }),
        signal: abortCtrl.signal,
      });

      // Give request time to start and enter prompt
      await new Promise((r) => setTimeout(r, 80));

      // Client disconnects
      abortCtrl.abort();

      await assert.rejects(resPromise);

      // Verify cancellation was captured and lease is released
      let waited = 0;
      while ((cancelledSessions.length === 0 || p1.activeLeaseCount > 0) && waited < 1000) {
        await new Promise((r) => setTimeout(r, 20));
        waited += 20;
      }
      assert.ok(cancelledSessions.length > 0);
      assert.equal(p1.activeLeaseCount, 0);
    } finally {
      await server.close();
    }
  });

  await t.test("Graceful shutdown: in-flight streaming request drains successfully within grace period", async () => {
    const { runtime: p1 } = createConfiguredMockRuntime({
      id: "account-a",
      onPrompt: async () => ({
        chunks: ["Graceful ", "drain ", "stream"],
        delayMs: 30,
      }),
    });

    const manager = new ProfileManager([p1]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0, shutdownGraceMs: 1500 },
    });

    await server.start();
    const port = server.port;

    // Start request
    const resPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "model-x",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    // Wait a brief moment for request to become active
    await new Promise((r) => setTimeout(r, 20));

    // Initiate graceful shutdown while request is in flight
    const closePromise = server.close();

    // The in-flight response should complete normally
    const res = await resPromise;
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("Graceful"));
    assert.ok(body.includes("stream"));
    assert.ok(body.includes("[DONE]"));

    await closePromise;
    assert.equal(p1.activeLeaseCount, 0);
  });

  await t.test("Graceful shutdown: turns exceeding shutdownGraceMs are aborted", async () => {
    const { runtime: p1, cancelledSessions } = createConfiguredMockRuntime({
      id: "account-a",
      onPrompt: async () => ({
        chunks: ["Chunk 1", "Chunk 2"],
        delayMs: 600, // exceeds grace period
      }),
    });

    const manager = new ProfileManager([p1]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0, shutdownGraceMs: 80 },
    });

    await server.start();
    const port = server.port;

    const resPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "model-x",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    // Wait for prompt to start
    await new Promise((r) => setTimeout(r, 60));

    // Close with short grace period
    await server.close();

    // Ensure session was cancelled and profile freed
    assert.ok(cancelledSessions.length > 0);
    assert.equal(p1.activeLeaseCount, 0);

    // Fetch may fail or close abruptly
    await resPromise.catch(() => {});
  });
});

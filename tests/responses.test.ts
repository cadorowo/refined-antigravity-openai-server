import assert from "node:assert/strict";
import test from "node:test";

import { AcpRuntimeClient } from "../src/acp/runtime-client.js";
import { ModelCatalog } from "../src/openai/models.js";
import type { ResponseObject } from "../src/openai/types.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { createServer } from "../src/server/server.js";
import { FakeAcpPeer, autoRespondInitialize } from "./helpers/fake-acp-connector.js";

interface SseParsedMessage {
  event?: string | undefined;
  data: string;
}

function parseSseStreamText(raw: string): SseParsedMessage[] {
  const lines = raw.split("\n");
  const messages: SseParsedMessage[] = [];
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice(6));
    } else if (line === "") {
      if (currentData.length > 0) {
        messages.push({
          event: currentEvent,
          data: currentData.join("\n"),
        });
        currentEvent = undefined;
        currentData = [];
      }
    }
  }

  if (currentData.length > 0) {
    messages.push({
      event: currentEvent,
      data: currentData.join("\n"),
    });
  }

  return messages;
}

interface MockRuntimeConfig {
  id: string;
  priority?: number;
  models?: string[];
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
  promptsReceived: string[];
} {
  const peer = new FakeAcpPeer();
  const cancelledSessions: string[] = [];
  const promptsReceived: string[] = [];
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

  const availableModels = (config.models ?? ["model-x", "model-y"]).map((m) => ({ modelId: m }));

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
          currentValue: availableModels[0]?.modelId,
          options: availableModels.map((m) => ({ value: m.modelId })),
        },
        {
          id: "thought_level",
          category: "thought_level",
          currentValue: "high",
          options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        },
      ],
      models: {
        availableModels,
        currentModelId: availableModels[0]?.modelId,
      },
    };
  };

  acpClient.setMode = async () => {};
  acpClient.setConfigOption = async () => {};

  acpClient.cancel = async (sessionId) => {
    cancelledSessions.push(sessionId);
  };

  acpClient.prompt = (sessionId, promptInput, promptOptions) => {
    const promptText = typeof promptInput === "string" ? promptInput : JSON.stringify(promptInput);
    promptsReceived.push(promptText);
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
              });
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
            usage: spec.usage ?? { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
          });
        },
      },
      result: resultPromise,
    };

    return turn;
  };

  const profileRuntime = new ProfileRuntime({
    config: {
      id: config.id,
      geminiHome: `/tmp/fake-gemini-${config.id}`,
      priority: config.priority ?? 1,
      enabled: true,
      sessionMode: "yolo",
    },
    runtime: acpClient,
  });


  return { runtime: profileRuntime, cancelledSessions, promptsReceived };
}

test("Responses API HTTP integration unit tests", async (t) => {
  await t.test("Non-streaming POST /v1/responses basic success with real usage", async () => {
    const mock = createConfiguredMockRuntime({
      id: "p1",
      onPrompt: async () => ({
        chunks: ["Hello, ", "this is a response!"],
        thoughts: ["Internal thought that must be filtered out"],
        tools: ["Internal tool call telemetry"],
        usage: { inputTokens: 50, outputTokens: 6, totalTokens: 56 },
      }),
    });

    const profileManager = new ProfileManager([mock.runtime]);
    const catalog = new ModelCatalog({
      profileManager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          input: "Say hello",
          metadata: { testKey: "testVal" },
        }),
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as ResponseObject;

      assert.equal(body.object, "response");
      assert.ok(body.id.startsWith("resp_"));
      assert.equal(body.status, "completed");
      assert.equal(body.model, "model-x");
      assert.equal(body.output_text, "Hello, this is a response!");
      assert.equal(body.output.length, 1);
      assert.ok(body.output[0]!.id.startsWith("msg_"));
      assert.equal(body.output[0]!.role, "assistant");
      assert.equal(body.output[0]!.content[0]!.type, "output_text");
      assert.equal(body.output[0]!.content[0]!.text, "Hello, this is a response!");


      // Verify privacy: internal thoughts/tools not present
      assert.equal(body.output_text.includes("Internal thought"), false);
      assert.equal(body.output_text.includes("Internal tool"), false);

      // Verify usage
      assert.deepEqual(body.usage, {
        input_tokens: 50,
        output_tokens: 6,
        total_tokens: 56,
      });

      assert.deepEqual(body.metadata, { testKey: "testVal" });

      // Verify response is stored in registry and retrievable via GET
      const getRes = await fetch(`http://127.0.0.1:${port}/v1/responses/${body.id}`);
      assert.equal(getRes.status, 200);
      const getBody = (await getRes.json()) as ResponseObject;
      assert.equal(getBody.id, body.id);
      assert.equal(getBody.output_text, body.output_text);
    } finally {
      await server.close();
    }
  });

  await t.test("Streaming POST /v1/responses emits typed SSE events in proper sequence", async () => {
    const mock = createConfiguredMockRuntime({
      id: "p1",
      onPrompt: async () => ({
        chunks: ["Delta 1 ", "Delta 2"],
        thoughts: ["Should not leak"],
        usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 },
      }),
    });

    const profileManager = new ProfileManager([mock.runtime]);
    const catalog = new ModelCatalog({
      profileManager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          input: "Stream test",
          stream: true,
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

      const sseText = await res.text();
      const messages = parseSseStreamText(sseText);

      // Verify sequence of events
      const expectedEventTypes = [
        "response.created",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ];

      assert.equal(messages.length, expectedEventTypes.length);

      let lastSeq = -1;
      let respId: string | null = null;
      let msgId: string | null = null;
      let accumulatedText = "";

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        assert.equal(msg.event, expectedEventTypes[i]);


        const parsed = JSON.parse(msg.data);
        assert.equal(parsed.type, expectedEventTypes[i]);
        assert.equal(parsed.sequence_number, lastSeq + 1);
        lastSeq = parsed.sequence_number;

        if (parsed.type === "response.created") {
          respId = parsed.response.id;
          assert.ok(respId?.startsWith("resp_"));
          assert.equal(parsed.response.status, "in_progress");
        } else if (parsed.type === "response.output_item.added") {
          msgId = parsed.item.id;
          assert.ok(msgId?.startsWith("msg_"));
        } else if (parsed.type === "response.output_text.delta") {
          assert.equal(parsed.item_id, msgId);
          accumulatedText += parsed.delta;
        } else if (parsed.type === "response.completed") {
          assert.equal(parsed.response.id, respId);
          assert.equal(parsed.response.status, "completed");
          assert.equal(parsed.response.output_text, "Delta 1 Delta 2");
          assert.deepEqual(parsed.response.usage, {
            input_tokens: 40,
            output_tokens: 4,
            total_tokens: 44,
          });
        }
      }

      assert.equal(accumulatedText, "Delta 1 Delta 2");
    } finally {
      await server.close();
    }
  });

  await t.test("previous_response_id stateful multi-turn continuation", async () => {
    let turnCount = 0;
    const mock = createConfiguredMockRuntime({
      id: "p1",
      onPrompt: async (turnNumber, promptText) => {
        turnCount++;
        if (turnCount === 1) {
          assert.ok(promptText.includes("ORBIT"));
          return { chunks: ["STORED"] };
        } else {
          // Verify turn 2 promptText contains the conversation history with ORBIT!
          assert.ok(promptText.includes("ORBIT"), "Continuation prompt must contain previous conversation with ORBIT");
          assert.ok(promptText.includes("What was codeword?"));
          return { chunks: ["ORBIT"] };
        }
      },
    });

    const profileManager = new ProfileManager([mock.runtime]);
    const catalog = new ModelCatalog({
      profileManager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      // Turn 1
      const res1 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          input: "Remember the codeword ORBIT. Reply only: STORED",
        }),
      });

      assert.equal(res1.status, 200);
      const body1 = (await res1.json()) as ResponseObject;
      assert.equal(body1.output_text, "STORED");

      // Turn 2: continuation
      const res2 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          previous_response_id: body1.id,
          input: "What was codeword? Reply only with the codeword.",
        }),
      });

      assert.equal(res2.status, 200);
      const body2 = (await res2.json()) as ResponseObject;
      assert.equal(body2.output_text, "ORBIT");
      assert.equal(body2.previous_response_id, body1.id);
    } finally {
      await server.close();
    }
  });

  await t.test("previous_response_id unknown returns 404 response_not_found", async () => {
    const mock = createConfiguredMockRuntime({ id: "p1" });
    const profileManager = new ProfileManager([mock.runtime]);
    const catalog = new ModelCatalog({
      profileManager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          previous_response_id: "resp_does_not_exist",
          input: "Hello",
        }),
      });

      assert.equal(res.status, 404);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, "response_not_found");
    } finally {
      await server.close();
    }
  });

  await t.test("Profile affinity: continuation prefers same profile", async () => {
    let profileUsedForTurn2 = "";
    const p1 = createConfiguredMockRuntime({
      id: "profile-a",
      priority: 1,
      onPrompt: async () => ({ chunks: ["Turn from profile-a"] }),
    });
    const p2 = createConfiguredMockRuntime({
      id: "profile-b",
      priority: 2,
      onPrompt: async () => {
        profileUsedForTurn2 = "profile-b";
        return { chunks: ["Turn from profile-b"] };
      },
    });

    const profileManager = new ProfileManager([p1.runtime, p2.runtime]);
    const catalog = new ModelCatalog({
      profileManager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      // Turn 1 routes to profile-a (higher priority)
      const res1 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "model-x", input: "Turn 1" }),
      });
      const body1 = (await res1.json()) as ResponseObject;

      // Turn 2 continuation with profile-a available -> should route to profile-a
      let p1Turn2 = false;
      p1.runtime.config.priority = 100; // Demote priority of profile-a
      // Even though profile-b now has priority 2 < 100, affinity should select profile-a!

      const res2 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "model-x",
          previous_response_id: body1.id,
          input: "Turn 2",
        }),
      });

      assert.equal(res2.status, 200);
      assert.equal(p1.promptsReceived.length, 2, "Profile A should have been selected via affinity despite lower priority");
    } finally {
      await server.close();
    }
  });

  await t.test("Pre-output failover: retryable error before chunk fails over to secondary profile", async () => {
    let p1Attempts = 0;
    let p2Attempts = 0;

    const p1 = createConfiguredMockRuntime({
      id: "p1",
      priority: 1,
      onPrompt: async () => {
        p1Attempts++;
        return {
          chunks: [],
          failBeforeFirstChunk: true, // Resource exhausted
        };
      },
    });

    const p2 = createConfiguredMockRuntime({
      id: "p2",
      priority: 2,
      onPrompt: async () => {
        p2Attempts++;
        return { chunks: ["Recovered on p2"] };
      },
    });

    const profileManager = new ProfileManager([p1.runtime, p2.runtime]);
    const catalog = new ModelCatalog({
      profileManager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "model-x", input: "Failover test" }),
      });

      assert.equal(res.status, 200);
      const body = (await res.json()) as ResponseObject;
      assert.equal(body.output_text, "Recovered on p2");
      assert.equal(p1Attempts, 1);
      assert.equal(p2Attempts, 1);
    } finally {
      await server.close();
    }
  });

  await t.test("Post-output failover boundary: failure after first chunk does NOT fail over to another profile", async () => {
    let p1Attempts = 0;
    let p2Attempts = 0;

    const p1 = createConfiguredMockRuntime({
      id: "p1",
      priority: 1,
      onPrompt: async () => {
        p1Attempts++;
        return {
          chunks: ["Chunk 1", "Chunk 2"],
          failAfterFirstChunk: true,
        };
      },
    });

    const p2 = createConfiguredMockRuntime({
      id: "p2",
      priority: 2,
      onPrompt: async () => {
        p2Attempts++;
        return { chunks: ["Should never run on p2"] };
      },
    });

    const profileManager = new ProfileManager([p1.runtime, p2.runtime]);
    const catalog = new ModelCatalog({
      profileManager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "model-x", input: "Stream test", stream: true }),
      });

      assert.equal(res.status, 200);
      await res.text();

      assert.equal(p1Attempts, 1);
      assert.equal(p2Attempts, 0, "Profile 2 must not be attempted once streaming output was committed");
    } finally {
      await server.close();
    }
  });

  await t.test("Client abort / cancellation cancels active turn and releases profile", async () => {
    const mock = createConfiguredMockRuntime({
      id: "p1",
      onPrompt: async () => {
        return {
          chunks: ["Long chunk"],
          delayMs: 1000,
        };
      },
    });

    const profileManager = new ProfileManager([mock.runtime]);
    const catalog = new ModelCatalog({
      profileManager,
      discoveryFn: async () => ["model-x"],
    });

    const server = createServer({
      profileManager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      const abortCtrl = new AbortController();
      const fetchPromise = fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "model-x", input: "Abort me" }),
        signal: abortCtrl.signal,
      });

      // Small delay then abort
      await new Promise((r) => setTimeout(r, 50));
      abortCtrl.abort();

      await fetchPromise.catch(() => {});

      // Give server event loop a moment to trigger abort handlers
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(mock.cancelledSessions.length > 0, "session/cancel must be sent on client abort");
      assert.equal(mock.runtime.activeLeaseCount, 0, "Profile lease must be released");
    } finally {
      await server.close();
    }
  });
});

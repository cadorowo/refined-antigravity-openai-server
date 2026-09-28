import assert from "node:assert/strict";
import test from "node:test";

import { AcpRuntimeClient } from "../src/acp/runtime-client.js";
import { normalizeUsage, type JsonRpcId, type PromptUsage } from "../src/acp/runtime-types.js";
import { ModelCatalog } from "../src/openai/models.js";
import type { ChatCompletionResponse } from "../src/openai/types.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { createServer } from "../src/server/server.js";
import type { AcpStreamMessage } from "../src/upstream/refined-antigravity.js";
import { FakeAcpPeer, autoRespondInitialize } from "./helpers/fake-acp-connector.js";

function asRequest(msg: AcpStreamMessage): { id: JsonRpcId; method: string; params?: any } {
  assert.ok("method" in msg && "id" in msg && msg.id !== null, "Expected message to be a JSON-RPC request");
  return msg as { id: JsonRpcId; method: string; params?: any };
}

test("Usage normalization and propagation unit tests", async (t) => {
  await t.test("normalizeUsage: sanitizes and validates token usage metrics", () => {
    // Valid complete usage
    const u1 = normalizeUsage({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      contextWindowMaxTokens: 1000000,
      contextWindowUsedTokens: 125,
    });
    assert.deepEqual(u1, {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      contextWindowMaxTokens: 1000000,
      contextWindowUsedTokens: 125,
    });

    // Calculates totalTokens if missing but input and output are present
    const u2 = normalizeUsage({
      inputTokens: 80,
      outputTokens: 20,
    });
    assert.deepEqual(u2, {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });

    // Returns undefined when input is null/undefined or empty object
    assert.equal(normalizeUsage(null), undefined);
    assert.equal(normalizeUsage(undefined), undefined);
    assert.equal(normalizeUsage({}), undefined);

    // Filters out negative, NaN, or non-numeric values
    const u3 = normalizeUsage({
      inputTokens: -5 as any,
      outputTokens: NaN as any,
      totalTokens: "invalid" as any,
    });
    assert.equal(u3, undefined);

    // Partial valid metrics
    const u4 = normalizeUsage({
      inputTokens: 50,
      outputTokens: undefined,
    });
    assert.deepEqual(u4, {
      inputTokens: 50,
    });
  });

  await t.test("AcpRuntimeClient: precedence 1: rawResult.usage is authoritative", async () => {
    const peer = new FakeAcpPeer();
    const acpClient = new AcpRuntimeClient({
      connector: peer.getConnector(),
      usageResolver: () => ({
        inputTokens: 999,
        outputTokens: 999,
        totalTokens: 1998,
      }),
    });

    const startPromise = acpClient.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // session/new
    const sessionPromise = acpClient.newSession({ cwd: "/tmp" });
    const newReq = asRequest(await peer.readMessage());
    assert.equal(newReq.method, "session/new");
    await peer.respondSuccess(newReq.id, { sessionId: "sess-usage-1" });
    const session = await sessionPromise;

    // session/prompt with explicit usage
    const turn = acpClient.prompt(session.sessionId, "Test");
    const promptReq = asRequest(await peer.readMessage());
    assert.equal(promptReq.method, "session/prompt");
    await peer.respondSuccess(promptReq.id, {
      stopReason: "end_turn",
      usage: {
        inputTokens: 50,
        outputTokens: 15,
        totalTokens: 65,
      },
    });

    const result = await turn.result;
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result.usage, {
      inputTokens: 50,
      outputTokens: 15,
      totalTokens: 65,
    });

    await acpClient.close();
    await peer.close();
  });

  await t.test("AcpRuntimeClient: precedence 2: usageResolver fallback when rawResult lacks usage", async () => {
    const peer = new FakeAcpPeer();
    let resolverCalled = false;
    let resolverSessionId: string | undefined;

    const acpClient = new AcpRuntimeClient({
      connector: peer.getConnector(),
      usageResolver: (sessionId) => {
        resolverCalled = true;
        resolverSessionId = sessionId;
        return {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        };
      },
    });

    const startPromise = acpClient.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // session/new
    const sessionPromise = acpClient.newSession({ cwd: "/tmp" });
    const newReq = asRequest(await peer.readMessage());
    await peer.respondSuccess(newReq.id, { sessionId: "sess-usage-resolver" });
    const session = await sessionPromise;

    // session/prompt WITHOUT usage
    const turn = acpClient.prompt(session.sessionId, "Test");
    const promptReq = asRequest(await peer.readMessage());
    await peer.respondSuccess(promptReq.id, {
      stopReason: "end_turn",
    });

    const result = await turn.result;
    assert.ok(resolverCalled, "usageResolver must be called");
    assert.equal(resolverSessionId, "sess-usage-resolver");
    assert.deepEqual(result.usage, {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });

    await acpClient.close();
    await peer.close();
  });

  await t.test("AcpRuntimeClient: precedence 3: cumulative usage_update fallback (latest wins)", async () => {
    const peer = new FakeAcpPeer();
    const acpClient = new AcpRuntimeClient({
      connector: peer.getConnector(),
    });

    const startPromise = acpClient.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // session/new
    const sessionPromise = acpClient.newSession({ cwd: "/tmp" });
    const newReq = asRequest(await peer.readMessage());
    await peer.respondSuccess(newReq.id, { sessionId: "sess-usage-update" });
    const session = await sessionPromise;

    // session/prompt
    const turn = acpClient.prompt(session.sessionId, "Test");
    const promptReq = asRequest(await peer.readMessage());

    // Send first usage update notification
    await peer.sendNotification("session/update", {
      sessionId: "sess-usage-update",
      update: {
        sessionUpdate: "usage_update",
        used: 40,
        size: 100000,
      },
    });

    // Send second (cumulative/latest) usage update notification
    await peer.sendNotification("session/update", {
      sessionId: "sess-usage-update",
      update: {
        sessionUpdate: "usage_update",
        used: 85,
        size: 100000,
      },
    });

    // Respond to prompt
    await peer.respondSuccess(promptReq.id, {
      stopReason: "end_turn",
    });

    for await (const _ of turn.updates) {
      // consume
    }
    const result = await turn.result;

    // Latest update (85) should be used as totalTokens and contextWindow metrics
    assert.deepEqual(result.usage, {
      totalTokens: 85,
      contextWindowMaxTokens: 100000,
      contextWindowUsedTokens: 85,
    });

    await acpClient.close();
    await peer.close();
  });

  await t.test("AcpRuntimeClient: missing usage reports undefined (never fake zeroes)", async () => {
    const peer = new FakeAcpPeer();
    const acpClient = new AcpRuntimeClient({
      connector: peer.getConnector(),
      usageResolver: () => null,
    });

    const startPromise = acpClient.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // session/new
    const sessionPromise = acpClient.newSession({ cwd: "/tmp" });
    const newReq = asRequest(await peer.readMessage());
    await peer.respondSuccess(newReq.id, { sessionId: "sess-no-usage" });
    const session = await sessionPromise;

    // session/prompt without usage
    const turn = acpClient.prompt(session.sessionId, "Test");
    const promptReq = asRequest(await peer.readMessage());
    await peer.respondSuccess(promptReq.id, {
      stopReason: "end_turn",
    });

    const result = await turn.result;
    assert.equal(result.usage, undefined, "Missing usage must be undefined, not fake zeroes");

    await acpClient.close();
    await peer.close();
  });

  await t.test("HTTP Server: non-streaming response omits usage when usage is unknown", async () => {
    const peer = new FakeAcpPeer();
    const acpClient = new AcpRuntimeClient({
      connector: peer.getConnector(),
    });

    const origStart = acpClient.start.bind(acpClient);
    acpClient.start = async () => {
      const p = origStart();
      await autoRespondInitialize(peer);
      return p;
    };

    acpClient.newSession = async (options) => ({
      sessionId: "mock-sess-no-usage-http",
      cwd: options.cwd,
      modes: { currentModeId: "yolo", availableModes: [{ id: "yolo" }] },
      configOptions: [{ id: "model", category: "model", currentValue: "test-model" }],
      models: { availableModels: [{ modelId: "test-model" }] },
    });

    acpClient.setMode = async () => {};
    acpClient.setConfigOption = async () => {};
    acpClient.prompt = (sessionId) => ({
      sessionId,
      updates: (async function* () {
        yield {
          sessionId,
          sessionUpdate: "agent_message_chunk",
          update: { content: { text: "Hello without usage" } },
          receivedAt: new Date().toISOString(),
        };
      })(),
      result: Promise.resolve({
        stopReason: "end_turn",
        usage: undefined,
      }),
    });

    const profile = new ProfileRuntime({
      config: { id: "p-no-usage", geminiHome: "/tmp/fake-home", enabled: true },
      runtime: acpClient,
    });

    const manager = new ProfileManager([profile]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["test-model"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
        }),
      });

      assert.equal(res.status, 200);
      const json = (await res.json()) as ChatCompletionResponse;
      assert.equal(json.choices[0]?.message.content, "Hello without usage");
      // Key assertion: usage must NOT be present (no fake 0/0/0)
      assert.equal(json.usage, undefined, "usage field must be omitted when unknown");
      assert.ok(!("usage" in json), "json should not have 'usage' key");
    } finally {
      await server.close();
    }
  });

  await t.test("HTTP Server: streaming SSE omits usage chunk when usage is unknown", async () => {
    const peer = new FakeAcpPeer();
    const acpClient = new AcpRuntimeClient({
      connector: peer.getConnector(),
    });

    const origStart = acpClient.start.bind(acpClient);
    acpClient.start = async () => {
      const p = origStart();
      await autoRespondInitialize(peer);
      return p;
    };

    acpClient.newSession = async (options) => ({
      sessionId: "mock-sess-stream-no-usage",
      cwd: options.cwd,
      modes: { currentModeId: "yolo", availableModes: [{ id: "yolo" }] },
      configOptions: [{ id: "model", category: "model", currentValue: "test-model" }],
      models: { availableModels: [{ modelId: "test-model" }] },
    });

    acpClient.setMode = async () => {};
    acpClient.setConfigOption = async () => {};
    acpClient.prompt = (sessionId) => ({
      sessionId,
      updates: (async function* () {
        yield {
          sessionId,
          sessionUpdate: "agent_message_chunk",
          update: { content: { text: "Stream text" } },
          receivedAt: new Date().toISOString(),
        };
      })(),
      result: Promise.resolve({
        stopReason: "end_turn",
        usage: undefined,
      }),
    });

    const profile = new ProfileRuntime({
      config: { id: "p-stream-no-usage", geminiHome: "/tmp/fake-home-2", enabled: true },
      runtime: acpClient,
    });

    const manager = new ProfileManager([profile]);
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["test-model"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    const port = server.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      assert.equal(res.status, 200);
      const text = await res.text();
      // Ensure NO usage event was sent since usage was unavailable
      assert.ok(!text.includes('"usage":'), "No usage chunk should be emitted when usage is undefined");
      assert.ok(text.includes("[DONE]"));
    } finally {
      await server.close();
    }
  });
});

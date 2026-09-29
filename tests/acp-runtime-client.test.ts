import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AcpRuntimeClient } from "../src/acp/runtime-client.js";
import {
  AcpRequestError,
  AcpTimeoutError,
  ConcurrentTurnError,
  RuntimeClosedError,
  RuntimeNotStartedError,
} from "../src/acp/errors.js";
import { PolicyPermissionHandler } from "../src/acp/permission-handler.js";
import { FakeAcpPeer, autoRespondInitialize } from "./helpers/fake-acp-connector.js";
import type { AcpStreamMessage } from "../src/upstream/refined-antigravity.js";
import type { JsonRpcId } from "../src/acp/runtime-types.js";

interface RequestMsg {
  id: JsonRpcId;
  method: string;
  params?: any;
}

interface NotificationMsg {
  method: string;
  params?: any;
}

function asRequest(msg: AcpStreamMessage): RequestMsg {
  assert.ok("method" in msg && "id" in msg && msg.id !== null, "Expected message to be a JSON-RPC request");
  return msg as RequestMsg;
}

function asNotification(msg: AcpStreamMessage): NotificationMsg {
  assert.ok("method" in msg && !("id" in msg), "Expected message to be a JSON-RPC notification");
  return msg as NotificationMsg;
}

describe("AcpRuntimeClient unit tests", () => {
  it("Test 1 — request/response correlation: generates unique ID and resolves response", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // Send a request
    const requestPromise = runtime.request<{ answer: number }>("custom/calculate", { x: 21 });

    const reqMsg = asRequest(await peer.readMessage());
    assert.equal(reqMsg.method, "custom/calculate");
    assert.deepEqual(reqMsg.params, { x: 21 });

    await peer.respondSuccess(reqMsg.id, { answer: 42 });

    const result = await requestPromise;
    assert.deepEqual(result, { answer: 42 });

    await runtime.close();
    await peer.close();
  });

  it("Test 1b — request error propagation: JSON-RPC errors reject with AcpRequestError", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    const requestPromise = runtime.request("custom/fail", {});
    const reqMsg = asRequest(await peer.readMessage());

    await peer.respondError(reqMsg.id, -32001, "Custom failure message", { detail: "bad input" });

    await assert.rejects(
      async () => requestPromise,
      (err: unknown) => {
        assert.ok(err instanceof AcpRequestError);
        assert.equal(err.rpcCode, -32001);
        assert.equal(err.message, "Custom failure message");
        assert.deepEqual(err.rpcData, { detail: "bad input" });
        return true;
      },
    );

    await runtime.close();
    await peer.close();
  });

  it("Test 2 — streaming updates: session/update is routed to the active turn", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    const sessionId = "session-stream-1";
    const turn = runtime.prompt(sessionId, "Please write code");

    // Agent reads session/prompt request
    const promptReq = asRequest(await peer.readMessage());
    assert.equal(promptReq.method, "session/prompt");

    // Agent sends intermediate updates
    await peer.sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: "Hello " }],
      },
    });

    await peer.sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: "world!" }],
      },
    });

    await peer.sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });

    // Agent finishes turn
    await peer.respondSuccess(promptReq.id, {
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    // Collect all streamed updates
    const receivedUpdates: string[] = [];
    for await (const update of turn.updates) {
      receivedUpdates.push(update.sessionUpdate);
    }

    assert.deepEqual(receivedUpdates, [
      "agent_message_chunk",
      "agent_message_chunk",
      "usage_update",
    ]);

    const result = await turn.result;
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });

    await runtime.close();
    await peer.close();
  });

  it("Test 3 — permission request: session/request_permission delegates to PermissionHandler", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({
      connector: peer.getConnector(),
      permissionHandler: new PolicyPermissionHandler("allow-once"),
    });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // Simulate Agent calling session/request_permission on client
    await peer.sendRequest(100, "session/request_permission", {
      sessionId: "sess-perm",
      toolCall: { toolCallId: "tool-1", kind: "execute", title: "Run pwd" },
      options: [
        { optionId: "opt-allow-id", kind: "allow_once", name: "Allow Once" },
        { optionId: "opt-deny-id", kind: "reject_once", name: "Deny" },
      ],
    });

    // Read response from client
    const responseMsg = await peer.readMessage();
    assert.ok("id" in responseMsg);
    assert.equal(responseMsg.id, 100);
    assert.ok("result" in responseMsg);
    assert.deepEqual(responseMsg.result, {
      outcome: { outcome: "selected", optionId: "opt-allow-id" },
    });

    await runtime.close();
    await peer.close();
  });

  it("Test 4 — unknown client RPC: unknown method returns -32601 and is recorded", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // Simulate Agent sending an unknown RPC method to client
    await peer.sendRequest(200, "extension/unsupportedMethod", { foo: "bar" });

    // Client must respond with JSON-RPC -32601 Method not found
    const responseMsg = await peer.readMessage();
    assert.ok("id" in responseMsg);
    assert.equal(responseMsg.id, 200);
    assert.ok("error" in responseMsg);
    assert.equal((responseMsg as any).error.code, -32601);
    assert.match((responseMsg as any).error.message, /Method not found/);

    // Verify unknown method was recorded
    assert.ok(runtime.unknownMethods.includes("extension/unsupportedMethod"));

    await runtime.close();
    await peer.close();
  });

  it("Test 5 — cancellation: AbortSignal sends session/cancel notification", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    const abortController = new AbortController();
    const sessionId = "sess-cancel-1";

    const turn = runtime.prompt(sessionId, "Take a long time", {
      signal: abortController.signal,
    });

    const promptReq = asRequest(await peer.readMessage());
    assert.equal(promptReq.method, "session/prompt");

    // Trigger abort
    abortController.abort();

    // Agent must receive session/cancel notification
    const cancelMsg = asNotification(await peer.readMessage());
    assert.equal(cancelMsg.method, "session/cancel");
    assert.deepEqual(cancelMsg.params, { sessionId });

    // Agent finishes with stopReason: cancelled
    await peer.respondSuccess(promptReq.id, {
      stopReason: "cancelled",
    });

    const result = await turn.result;
    assert.equal(result.stopReason, "cancelled");

    await runtime.close();
    await peer.close();
  });

  it("Test 6 — concurrency: second foreground prompt throws ConcurrentTurnError", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    const turn1 = runtime.prompt("sess-1", "Prompt 1");

    // Second prompt call on the same runtime while turn1 is in-flight
    assert.throws(
      () => runtime.prompt("sess-1", "Prompt 2"),
      (err: unknown) => err instanceof ConcurrentTurnError,
    );

    // Complete turn 1
    const promptReq = asRequest(await peer.readMessage());
    assert.equal(promptReq.method, "session/prompt");

    await peer.respondSuccess(promptReq.id, { stopReason: "end_turn" });
    await turn1.result;

    // After turn 1 finishes, subsequent prompt succeeds
    const turn2 = runtime.prompt("sess-1", "Prompt 2 now works");
    const promptReq2 = asRequest(await peer.readMessage());
    await peer.respondSuccess(promptReq2.id, { stopReason: "end_turn" });
    await turn2.result;

    await runtime.close();
    await peer.close();
  });

  it("Test 7 — lifecycle/start race: concurrent start() calls share single initialization", async () => {
    let connectorCallCount = 0;
    const peer = new FakeAcpPeer();
    const connector = () => {
      connectorCallCount++;
      return peer.getConnector()();
    };

    const runtime = new AcpRuntimeClient({ connector });

    // Launch 3 concurrent start calls
    const p1 = runtime.start();
    const p2 = runtime.start();
    const p3 = runtime.start();

    await autoRespondInitialize(peer);
    await Promise.all([p1, p2, p3]);

    assert.equal(connectorCallCount, 1);
    assert.equal(runtime.isStarted, true);

    // Calling start() again after it started is a no-op
    await runtime.start();
    assert.equal(connectorCallCount, 1);

    await runtime.close();
    await peer.close();
  });

  it("Test 8 — cleanup on close(): rejects pending requests and cancels active turn", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // Launch a prompt and a pending request
    const turn = runtime.prompt("sess-close", "prompt before close");
    const pendingReqPromise = runtime.request("custom/pending", {});

    // Read the prompt request
    const promptReq = asRequest(await peer.readMessage());
    assert.equal(promptReq.method, "session/prompt");

    // Close runtime while requests are active
    const closePromise = runtime.close();

    // Active turn updates should fail with RuntimeClosedError
    await assert.rejects(
      async () => {
        for await (const _ of turn.updates) {}
      },
      (err: unknown) => err instanceof RuntimeClosedError,
    );

    // Active turn result should reject with RuntimeClosedError
    await assert.rejects(
      async () => turn.result,
      (err: unknown) => err instanceof RuntimeClosedError,
    );

    // Pending request should reject with RuntimeClosedError
    await assert.rejects(
      async () => pendingReqPromise,
      (err: unknown) => err instanceof RuntimeClosedError,
    );

    await closePromise;
    assert.equal(runtime.isClosed, true);

    // Operations after close throw RuntimeClosedError
    await assert.rejects(
      async () => runtime.start(),
      (err: unknown) => err instanceof RuntimeClosedError,
    );
    assert.throws(
      () => runtime.prompt("sess-close", "new prompt"),
      (err: unknown) => err instanceof RuntimeClosedError,
    );

    await peer.close();
  });

  it("Test 9 — multi-instance isolation: two runtimes operate concurrently without interference", async () => {
    const peerA = new FakeAcpPeer();
    const peerB = new FakeAcpPeer();

    const runtimeA = new AcpRuntimeClient({ connector: peerA.getConnector() });
    const runtimeB = new AcpRuntimeClient({ connector: peerB.getConnector() });

    const startA = runtimeA.start();
    const startB = runtimeB.start();

    await Promise.all([
      autoRespondInitialize(peerA),
      autoRespondInitialize(peerB),
      startA,
      startB,
    ]);

    assert.equal(runtimeA.isStarted, true);
    assert.equal(runtimeB.isStarted, true);

    const turnA = runtimeA.prompt("sess-A", "Prompt A");
    const turnB = runtimeB.prompt("sess-B", "Prompt B");

    const reqA = asRequest(await peerA.readMessage());
    const reqB = asRequest(await peerB.readMessage());

    assert.equal(reqA.params.sessionId, "sess-A");
    assert.equal(reqB.params.sessionId, "sess-B");

    await peerA.respondSuccess(reqA.id, { stopReason: "end_turn_A" });
    await peerB.respondSuccess(reqB.id, { stopReason: "end_turn_B" });

    const [resA, resB] = await Promise.all([turnA.result, turnB.result]);
    assert.equal(resA.stopReason, "end_turn_A");
    assert.equal(resB.stopReason, "end_turn_B");

    await runtimeA.close();
    await runtimeB.close();
    await peerA.close();
    await peerB.close();
  });

  it("Test 10 — request timeout: throws AcpTimeoutError when timeout expires", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    // Send request with short timeout
    const reqPromise = runtime.request("custom/timeoutTest", {}, { timeoutMs: 50 });
    const reqMsg = await peer.readMessage();
    assert.ok(reqMsg);

    // Do not respond; wait for timeout
    await assert.rejects(
      async () => reqPromise,
      (err: unknown) => {
        assert.ok(err instanceof AcpTimeoutError);
        assert.equal(err.method, "custom/timeoutTest");
        assert.equal(err.timeoutMs, 50);
        return true;
      },
    );

    await runtime.close();
    await peer.close();
  });

  it("Test 11 — newSession, setMode, setConfigOption store session state", async () => {
    const peer = new FakeAcpPeer();
    const runtime = new AcpRuntimeClient({ connector: peer.getConnector() });

    const startPromise = runtime.start();
    await autoRespondInitialize(peer);
    await startPromise;

    const newSessionPromise = runtime.newSession({ cwd: "/fake/dir" });
    const newSessionReq = asRequest(await peer.readMessage());
    assert.equal(newSessionReq.method, "session/new");
    assert.equal(newSessionReq.params.cwd, "/fake/dir");

    await peer.respondSuccess(newSessionReq.id, {
      sessionId: "s-123",
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "yolo", name: "YOLO" },
        ],
      },
      configOptions: [
        { id: "model", currentValue: "gemini-3.8-flash" },
      ],
      models: {
        currentModelId: "gemini-3.8-flash",
        availableModels: [{ modelId: "gemini-3.8-flash" }],
      },
    });

    const session = await newSessionPromise;
    assert.equal(session.sessionId, "s-123");
    assert.equal(session.cwd, "/fake/dir");
    assert.equal(session.modes?.currentModeId, "default");
    assert.equal(session.models?.currentModelId, "gemini-3.8-flash");

    // setMode
    const setModePromise = runtime.setMode("s-123", "yolo");
    const setModeReq = asRequest(await peer.readMessage());
    assert.equal(setModeReq.method, "session/set_mode");
    assert.equal(setModeReq.params.modeId, "yolo");
    await peer.respondSuccess(setModeReq.id, {});
    await setModePromise;
    assert.equal(runtime.getSession("s-123")?.modes?.currentModeId, "yolo");

    // setConfigOption
    const setConfigPromise = runtime.setConfigOption("s-123", "model", "gemini-3.1-pro");
    const setConfigReq = asRequest(await peer.readMessage());
    assert.equal(setConfigReq.method, "session/set_config_option");
    assert.equal(setConfigReq.params.configId, "model");
    assert.equal(setConfigReq.params.value, "gemini-3.1-pro");
    await peer.respondSuccess(setConfigReq.id, {});
    await setConfigPromise;
    assert.equal(
      runtime.getSession("s-123")?.configOptions?.find((c) => c.id === "model")?.currentValue,
      "gemini-3.1-pro",
    );

    runtime.forgetSession("s-123");
    assert.equal(runtime.getSession("s-123"), undefined);

    await runtime.close();
    await peer.close();
  });
});

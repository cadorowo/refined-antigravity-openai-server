import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ResponseRegistry, type ResponseRecord } from "../src/openai/response-registry.js";

test("ResponseRegistry unit tests", async (t) => {
  await t.test("put and get retrieves stored record", () => {
    const registry = new ResponseRegistry({ maxEntries: 10, ttlMs: 10000 });
    const record: ResponseRecord = {
      id: "resp_1",
      createdAt: 100,
      completedAt: 101,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws1",
      transcript: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      outputText: "hello",
      status: "completed",
      store: true,
    };

    registry.save(record);
    assert.equal(registry.size, 1);

    const retrieved = registry.get("resp_1");
    assert.ok(retrieved);
    assert.equal(retrieved.id, "resp_1");
    assert.equal(retrieved.outputText, "hello");
    assert.equal(retrieved.model, "gemini-3.8-flash");
  });

  await t.test("unknown ID returns undefined", () => {
    const registry = new ResponseRegistry();
    assert.equal(registry.get("resp_non_existent"), undefined);
  });

  await t.test("store=false records are not retained in registry", () => {
    const registry = new ResponseRegistry();
    const record: ResponseRecord = {
      id: "resp_ephemeral",
      createdAt: 100,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws-ephemeral",
      transcript: [{ role: "user", content: "hi" }],
      outputText: "hello",
      status: "completed",
      store: false,
    };

    registry.save(record);
    assert.equal(registry.size, 0);
    assert.equal(registry.get("resp_ephemeral"), undefined);
  });

  await t.test("TTL expiration evicts expired record on get", async () => {
    const registry = new ResponseRegistry({ ttlMs: 50 }); // 50ms TTL
    const record: ResponseRecord = {
      id: "resp_short_ttl",
      createdAt: 100,
      lastAccessedAt: Date.now() - 100, // already expired
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws_ttl",
      transcript: [],
      outputText: "bye",
      status: "completed",
      store: true,
    };

    registry.save(record);
    assert.equal(registry.get("resp_short_ttl"), undefined);
    assert.equal(registry.size, 0);
  });


  await t.test("maxEntries enforces bounded capacity by evicting oldest", () => {
    const registry = new ResponseRegistry({ maxEntries: 3, ttlMs: 100000 });
    const now = Date.now();

    for (let i = 1; i <= 3; i++) {
      registry.save({
        id: `resp_${i}`,
        createdAt: now - 5000 + i,
        lastAccessedAt: now - 3000 + i * 10,
        model: "gemini-3.8-flash",
        workspace: `/tmp/ws_${i}`,
        transcript: [],
        outputText: `out_${i}`,
        status: "completed",
        store: true,
      });
    }

    assert.equal(registry.size, 3);
    assert.ok(registry.get("resp_1"));

    // Add 4th record - should evict the oldest
    registry.save({
      id: "resp_4",
      createdAt: 104,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws_4",
      transcript: [],
      outputText: "out_4",
      status: "completed",
      store: true,
    });

    assert.equal(registry.size, 3);
    assert.ok(registry.get("resp_4"));
    // Since resp_1 was accessed right before resp_4, resp_2 should have been the oldest and evicted!
    assert.equal(registry.get("resp_2"), undefined);
  });

  await t.test("immutable parent and branching semantics", () => {
    const registry = new ResponseRegistry();
    const parent: ResponseRecord = {
      id: "resp_parent",
      createdAt: 100,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws_parent",
      transcript: [{ role: "user", content: "Remember secret: KESTREL" }, { role: "assistant", content: "Stored" }],
      outputText: "Stored",
      status: "completed",
      store: true,
    };
    registry.save(parent);

    // Branch A
    const branchA: ResponseRecord = {
      id: "resp_branch_a",
      createdAt: 101,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      previousResponseId: "resp_parent",
      workspace: parent.workspace,
      transcript: [
        ...parent.transcript,
        { role: "user", content: "What is secret?" },
        { role: "assistant", content: "KESTREL" },
      ],
      outputText: "KESTREL",
      status: "completed",
      store: true,
    };
    registry.save(branchA);

    // Branch B
    const branchB: ResponseRecord = {
      id: "resp_branch_b",
      createdAt: 102,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      previousResponseId: "resp_parent",
      workspace: parent.workspace,
      transcript: [
        ...parent.transcript,
        { role: "user", content: "Tell me a joke" },
        { role: "assistant", content: "A programmer walks into a bar" },
      ],
      outputText: "A programmer walks into a bar",
      status: "completed",
      store: true,
    };
    registry.save(branchB);

    // Verify parent is untouched
    const parentCheck = registry.get("resp_parent");
    assert.ok(parentCheck);
    assert.equal(parentCheck.transcript.length, 2);

    // Verify branch A has its 4 messages
    const aCheck = registry.get("resp_branch_a");
    assert.ok(aCheck);
    assert.equal(aCheck.transcript.length, 4);
    assert.equal(aCheck.outputText, "KESTREL");

    // Verify branch B has its 4 messages
    const bCheck = registry.get("resp_branch_b");
    assert.ok(bCheck);
    assert.equal(bCheck.transcript.length, 4);
    assert.equal(bCheck.outputText, "A programmer walks into a bar");
  });

  await t.test("toResponseObject converts record to OpenAI response shape", () => {
    const registry = new ResponseRegistry();
    const record: ResponseRecord = {
      id: "resp_abc123",
      createdAt: 1700000000,
      completedAt: 1700000005,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws",
      transcript: [{ role: "user", content: "hi" }],
      outputText: "Hello there!",
      status: "completed",
      instructions: "Be helpful",
      metadata: { env: "test" },
      usage: {
        input_tokens: 15,
        output_tokens: 4,
        total_tokens: 19,
      },
      store: true,
    };

    const resObj = registry.toResponseObject(record);
    assert.equal(resObj.id, "resp_abc123");
    assert.equal(resObj.object, "response");
    assert.equal(resObj.status, "completed");
    assert.equal(resObj.model, "gemini-3.8-flash");
    assert.equal(resObj.output_text, "Hello there!");
    assert.equal(resObj.output[0]!.role, "assistant");
    assert.equal(resObj.output[0]!.content[0]!.type, "output_text");
    assert.equal(resObj.output[0]!.content[0]!.text, "Hello there!");

    assert.deepEqual(resObj.usage, {
      input_tokens: 15,
      output_tokens: 4,
      total_tokens: 19,
    });
    assert.deepEqual(resObj.metadata, { env: "test" });
  });

  await t.test("close cleans up registered workspaces", async () => {
    const tempWs = await fs.mkdtemp(path.join(os.tmpdir(), "reg-test-ws-"));
    const registry = new ResponseRegistry();
    registry.save({
      id: "resp_close_test",
      createdAt: 100,
      lastAccessedAt: Date.now(),
      model: "test-model",
      workspace: tempWs,
      transcript: [],
      outputText: "done",
      status: "completed",
      store: true,
    });

    assert.equal(registry.size, 1);
    await registry.close();
    assert.equal(registry.size, 0);

    // Verify directory was removed
    let exists = true;
    try {
      await fs.stat(tempWs);
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "Expected workspace to be cleaned up on close");
  });
});

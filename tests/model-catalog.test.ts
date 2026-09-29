import assert from "node:assert/strict";
import test from "node:test";

import type { SessionState } from "../src/acp/runtime-types.js";
import { OpenAIHttpError } from "../src/openai/errors.js";
import {
  ModelCatalog,
  extractModelsFromSession,
} from "../src/openai/models.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { FakeAcpPeer, autoRespondInitialize } from "./helpers/fake-acp-connector.js";
import { AcpRuntimeClient } from "../src/acp/runtime-client.js";

function createTestRuntime(profileId: string): ProfileRuntime {
  const peer = new FakeAcpPeer();
  const acpClient = new AcpRuntimeClient({
    connector: peer.getConnector(),
  });
  // Auto-respond initialize in background when start() is called
  const originalStart = acpClient.start.bind(acpClient);
  acpClient.start = async () => {
    const p = originalStart();
    await autoRespondInitialize(peer);
    return p;
  };

  return new ProfileRuntime({
    config: {
      id: profileId,
      geminiHome: `/tmp/fake-${profileId}`,
      enabled: true,
      priority: 1,
    },
    runtime: acpClient,
  });
}

test("ModelCatalog unit tests", async (t) => {
  await t.test("extractModelsFromSession extracts from models and configOptions", () => {
    const session: SessionState = {
      sessionId: "s1",
      models: {
        currentModelId: "gemini-3.8-flash",
        availableModels: [
          { modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
          { modelId: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          options: [
            { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
            { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
          ],
        },
      ],
    };

    const extracted = extractModelsFromSession(session);
    assert.deepEqual(extracted.sort(), ["gemini-3.1-pro", "gemini-3.7-flash", "gemini-3.8-flash"].sort());
  });

  await t.test("discovers models from a single profile", async () => {
    const p1 = createTestRuntime("account-a");
    const manager = new ProfileManager([p1]);

    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["gemini-3.8-flash", "gemini-3.7-flash"],
    });

    const list = await catalog.listModels();
    assert.equal(list.object, "list");
    assert.equal(list.data.length, 2);
    assert.deepEqual(list.data[0], {
      id: "gemini-3.8-flash",
      object: "model",
      created: 0,
      owned_by: "antigravity",
    });

    const single = await catalog.getModel("gemini-3.8-flash");
    assert.ok(single);
    assert.equal(single.id, "gemini-3.8-flash");

    const unknown = await catalog.getModel("nonexistent");
    assert.equal(unknown, undefined);
  });

  await t.test("unions models across multiple profiles and deduplicates", async () => {
    const p1 = createTestRuntime("account-a");
    const p2 = createTestRuntime("account-b");
    const manager = new ProfileManager([p1, p2]);

    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async (profile) => {
        if (profile.id === "account-a") {
          return ["gemini-3.8-flash", "gemini-3.7-flash"];
        }
        return ["gemini-3.8-flash", "gemini-special-pro"];
      },
    });

    const list = await catalog.listModels();
    const ids = list.data.map((m) => m.id).sort();
    assert.deepEqual(ids, ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-special-pro"].sort());

    // Check cross-profile model mapping
    const flashProfiles = catalog.getProfilesForModel("gemini-3.8-flash");
    assert.deepEqual(flashProfiles.sort(), ["account-a", "account-b"].sort());

    const specialProfiles = catalog.getProfilesForModel("gemini-special-pro");
    assert.deepEqual(specialProfiles, ["account-b"]);
  });

  await t.test("failover: discovers from profile B if profile A discovery fails", async () => {
    const p1 = createTestRuntime("account-a");
    const p2 = createTestRuntime("account-b");
    const manager = new ProfileManager([p1, p2]);

    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async (profile) => {
        if (profile.id === "account-a") {
          throw new Error("HTTP 401: Authentication required");
        }
        return ["gemini-3.8-flash", "gemini-3.1-pro"];
      },
    });

    const list = await catalog.listModels();
    assert.equal(list.data.length, 2);
    assert.deepEqual(catalog.getProfilesForModel("gemini-3.8-flash"), ["account-b"]);
  });

  await t.test("fails with 503 if all profiles fail discovery", async () => {
    const p1 = createTestRuntime("account-a");
    const manager = new ProfileManager([p1]);

    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => {
        throw new Error("503 Service Temporarily Unavailable");
      },
    });

    await assert.rejects(
      () => catalog.listModels(),
      (err: unknown) => err instanceof OpenAIHttpError && err.statusCode === 503,
    );
  });

  await t.test("cache hit avoids redundant discovery; refresh forces it", async () => {
    const p1 = createTestRuntime("account-a");
    const manager = new ProfileManager([p1]);
    let callCount = 0;

    const catalog = new ModelCatalog({
      profileManager: manager,
      cacheTtlMs: 60_000,
      discoveryFn: async () => {
        callCount++;
        return ["gemini-3.8-flash"];
      },
    });

    await catalog.listModels();
    assert.equal(callCount, 1);

    // Second call hits cache
    await catalog.listModels();
    await catalog.getModel("gemini-3.8-flash");
    assert.equal(callCount, 1);

    // Refresh bypasses cache
    await catalog.refresh();
    assert.equal(callCount, 2);
  });

  await t.test("busy profile retains its own cached models without discovery fallback", async () => {
    const p1 = createTestRuntime("account-a");
    const p2 = createTestRuntime("account-b");
    const manager = new ProfileManager([p1, p2]);
    const discovered: string[] = [];
    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async (profile) => {
        discovered.push(profile.id);
        return [profile.id === "account-a" ? "model-a" : "model-b"];
      },
    });

    await catalog.listModels();
    p1.acquireLease();
    discovered.length = 0;
    await catalog.refresh();
    assert.deepEqual(discovered, ["account-b"]);
    assert.deepEqual(catalog.getProfilesForModel("model-a"), ["account-a"]);
    assert.deepEqual(catalog.getProfilesForModel("model-b"), ["account-b"]);
    p1.releaseLease();
    await catalog.refresh();
    assert.deepEqual(discovered, ["account-b", "account-a", "account-b"]);
  });
});

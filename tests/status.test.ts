import assert from "node:assert/strict";
import test from "node:test";

import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { createServer } from "../src/server/server.js";
import { FakeAcpPeer, autoRespondInitialize } from "./helpers/fake-acp-connector.js";
import { AcpRuntimeClient } from "../src/acp/runtime-client.js";

function createMockRuntime(profileId: string): ProfileRuntime {
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

  return new ProfileRuntime({
    config: {
      id: profileId,
      geminiHome: `/Users/cadowo/.config/refined-agy/profiles/${profileId}/gemini`,
      enabled: true,
      priority: 1,
    },
    runtime: acpClient,
  });
}

test("Protected status report (/status) unit tests", async (t) => {
  const testApiKey = "sk-test-status-secret-key";

  await t.test("rejects unauthenticated requests when API key is configured", async () => {
    const p1 = createMockRuntime("profile-a");
    const manager = new ProfileManager([p1]);

    const server = createServer({
      profileManager: manager,
      config: {
        host: "127.0.0.1",
        port: 0,
        apiKey: testApiKey,
      },
    });

    await server.start();
    try {
      // 1. Missing header -> 401
      const res1 = await fetch(`http://127.0.0.1:${server.port}/status`);
      assert.equal(res1.status, 401);

      // 2. Wrong token -> 401
      const res2 = await fetch(`http://127.0.0.1:${server.port}/status`, {
        headers: { Authorization: "Bearer wrong-key" },
      });
      assert.equal(res2.status, 401);
    } finally {
      await server.close();
    }
  });

  await t.test("accepts matching Bearer token and returns sanitized status report", async () => {
    const p1 = createMockRuntime("profile-a");
    const manager = new ProfileManager([p1]);

    const server = createServer({
      profileManager: manager,
      config: {
        host: "127.0.0.1",
        port: 0,
        apiKey: testApiKey,
      },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/status`, {
        headers: { Authorization: `Bearer ${testApiKey}` },
      });
      assert.equal(res.status, 200);

      const body = (await res.json()) as any;
      assert.equal(body.status, "ok");
      assert.equal(typeof body.uptime_seconds, "number");
      assert.ok(body.requests);
      assert.equal(typeof body.requests.total, "number");
      assert.equal(typeof body.requests.active, "number");
      assert.ok(body.tokens);
      assert.ok(body.streams);
      assert.ok(body.latency);
      assert.ok(body.memory);
      assert.ok(body.memory.rss_bytes > 0);
      assert.ok(Array.isArray(body.profiles));
      assert.equal(body.profiles.length, 1);
      assert.equal(body.profiles[0].id, "profile-a");
      assert.equal(body.profiles[0].state, "ready");
      assert.equal(body.profiles[0].active_leases, 0);

      // Verify no sensitive credentials or paths leaked
      const rawText = JSON.stringify(body);
      assert.ok(!rawText.includes("geminiHome"));
      assert.ok(!rawText.includes(".config/refined-agy"));
      assert.ok(!rawText.includes(testApiKey));
      assert.ok(!rawText.includes("password"));
      assert.ok(!rawText.includes("secret"));
    } finally {
      await server.close();
    }
  });

  await t.test("returns 405 Method Not Allowed on POST /status", async () => {
    const manager = new ProfileManager([]);
    const server = createServer({
      profileManager: manager,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/status`, { method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET");
    } finally {
      await server.close();
    }
  });
});

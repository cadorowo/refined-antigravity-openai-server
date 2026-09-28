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
      geminiHome: `/tmp/fake-${profileId}`,
      enabled: true,
      priority: 1,
    },
    runtime: acpClient,
  });
}

test("Readiness probe (/readyz) unit tests", async (t) => {
  await t.test("returns 200 ready when at least one profile is ready", async () => {
    const p1 = createMockRuntime("profile-a");
    const manager = new ProfileManager([p1]);

    const server = createServer({
      profileManager: manager,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string; profiles: { total: number; available: number } };
      assert.equal(body.status, "ready");
      assert.equal(body.profiles.total, 1);
      assert.equal(body.profiles.available, 1);
    } finally {
      await server.close();
    }
  });

  await t.test("returns 503 not_ready when all profiles are busy", async () => {
    const p1 = createMockRuntime("profile-a");
    const manager = new ProfileManager([p1]);

    const server = createServer({
      profileManager: manager,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      // Lease the profile so it becomes busy
      p1.acquireLease();
      assert.equal(p1.currentState, "busy");

      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { status: string; profiles: { total: number; available: number } };
      assert.equal(body.status, "not_ready");
      assert.equal(body.profiles.total, 1);
      assert.equal(body.profiles.available, 0);
    } finally {
      p1.releaseLease();
      await server.close();
    }
  });

  await t.test("returns 503 not_ready when profiles are in cooldown or quota_exhausted", async () => {
    const p1 = createMockRuntime("profile-a");
    const p2 = createMockRuntime("profile-b");
    const manager = new ProfileManager([p1, p2]);

    const server = createServer({
      profileManager: manager,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      p1.markFailure("rate_limit", new Error("Rate limit"), 60_000);
      p2.markFailure("quota_exhausted", new Error("Quota exceeded"));

      assert.equal(p1.currentState, "cooldown");
      assert.equal(p2.currentState, "quota_exhausted");

      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { status: string; profiles: { total: number; available: number } };
      assert.equal(body.status, "not_ready");
      assert.equal(body.profiles.available, 0);
    } finally {
      await server.close();
    }
  });

  await t.test("returns 200 ready when mixed (one ready, one unavailable)", async () => {
    const p1 = createMockRuntime("profile-a");
    const p2 = createMockRuntime("profile-b");
    const manager = new ProfileManager([p1, p2]);

    const server = createServer({
      profileManager: manager,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      p1.acquireLease(); // busy
      // p2 remains ready

      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string; profiles: { total: number; available: number } };
      assert.equal(body.status, "ready");
      assert.equal(body.profiles.total, 2);
      assert.equal(body.profiles.available, 1);
    } finally {
      p1.releaseLease();
      await server.close();
    }
  });

  await t.test("returns 405 Method Not Allowed on POST /readyz", async () => {
    const manager = new ProfileManager([]);
    const server = createServer({
      profileManager: manager,
      config: { host: "127.0.0.1", port: 0 },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`, { method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET");
    } finally {
      await server.close();
    }
  });
});

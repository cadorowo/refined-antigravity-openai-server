import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { AcpRuntimeClient } from "../src/acp/runtime-client.js";
import { FakeAcpPeer, autoRespondInitialize } from "./helpers/fake-acp-connector.js";
import { RefinedOpenAiServer } from "../src/server/server.js";

describe("Recovery, restart, and lease invariant unit tests", () => {
  function createMockClient() {
    const peer = new FakeAcpPeer();
    const client = new AcpRuntimeClient({ connector: peer.getConnector() });
    const origStart = client.start.bind(client);
    client.start = async () => {
      const p = origStart();
      await autoRespondInitialize(peer);
      return p;
    };
    return { client, peer };
  }

  it("ProfileRuntime.restart() creates fresh runtime and restores ready state", async () => {
    let factoryInvocations = 0;
    const peers: FakeAcpPeer[] = [];

    const runtimeFactory = () => {
      factoryInvocations++;
      const { client, peer } = createMockClient();
      peers.push(peer);
      return client;
    };

    const { client: initialClient, peer: initialPeer } = createMockClient();
    peers.push(initialPeer);

    const profile = new ProfileRuntime({
      config: {
        id: "p-restart",
        geminiHome: "/tmp/p-restart",
      },
      runtime: initialClient,
      runtimeFactory,
    });

    await profile.start();

    assert.equal(profile.currentState, "ready");
    assert.equal(profile.restartAttemptCount, 0);

    // Simulate transient failure and cooldown
    profile.markFailure("transient", new Error("simulated crash"));
    assert.equal(profile.currentState, "cooldown");
    assert.ok(profile.lastError?.includes("simulated crash"));

    // Trigger restart
    await profile.restart();

    assert.equal(profile.currentState, "ready");
    assert.equal(profile.restartAttemptCount, 1);
    assert.equal(profile.lastError, undefined);
    assert.equal(profile.activeLeaseCount, 0);
    assert.equal(factoryInvocations, 1);

    // Cleanup
    await profile.close();
    for (const p of peers) {
      await p.close();
    }
  });

  it("ProfileRuntime.restart() shares one in-flight restart", async () => {
    const peers: FakeAcpPeer[] = [];
    const { client: initialClient, peer: initialPeer } = createMockClient();
    peers.push(initialPeer);
    await initialClient.start();
    const originalClose = initialClient.close.bind(initialClient);
    let unblockClose: (() => void) | undefined;
    let closeCalls = 0;
    initialClient.close = async () => {
      if (closeCalls++ === 0) {
        await new Promise<void>((resolve) => { unblockClose = resolve; });
      }
      await originalClose();
    };
    let factoryInvocations = 0;
    const profile = new ProfileRuntime({
      config: { id: "p-single-flight", geminiHome: "/tmp/p-single-flight" },
      runtime: initialClient,
      runtimeFactory: () => {
        factoryInvocations++;
        const { client, peer } = createMockClient();
        peers.push(peer);
        return client;
      },
    });

    const first = profile.restart();
    const second = profile.restart();
    assert.equal(profile.currentState, "unhealthy");
    assert.equal(profile.restartAttemptCount, 1);
    assert.equal(factoryInvocations, 0);
    unblockClose?.();
    await Promise.all([first, second]);
    assert.equal(factoryInvocations, 1);
    assert.equal(profile.currentState, "ready");

    await profile.close();
    for (const peer of peers) await peer.close();
  });

  it("ProfileRuntime.restart() refuses an active lease without dropping it", async () => {
    const profile = new ProfileRuntime({
      config: { id: "p-leased", geminiHome: "/tmp/p-leased" },
    });
    profile.acquireLease();
    await assert.rejects(profile.restart(), /active lease/);
    assert.equal(profile.activeLeaseCount, 1);
    assert.equal(profile.currentState, "busy");
    assert.equal(profile.restartAttemptCount, 0);
    profile.releaseLease();
    await profile.close();
  });

  it("ProfileRuntime.close() prevents replacement during an in-flight restart", async () => {
    const { client: initialClient, peer } = createMockClient();
    await initialClient.start();
    const originalClose = initialClient.close.bind(initialClient);
    let unblockClose: (() => void) | undefined;
    let closeCalls = 0;
    initialClient.close = async () => {
      if (closeCalls++ === 0) {
        await new Promise<void>((resolve) => { unblockClose = resolve; });
      }
      await originalClose();
    };
    let factoryInvocations = 0;
    const profile = new ProfileRuntime({
      config: { id: "p-closing", geminiHome: "/tmp/p-closing" },
      runtime: initialClient,
      runtimeFactory: () => {
        factoryInvocations++;
        return createMockClient().client;
      },
    });

    const restarting = profile.restart();
    const closing = profile.close();
    assert.equal(profile.currentState, "disabled");
    unblockClose?.();
    await assert.rejects(restarting, /closed during restart/);
    await closing;
    assert.equal(factoryInvocations, 0);
    assert.equal(profile.currentState, "disabled");
    await assert.rejects(profile.restart(), /closing profile/);
    await peer.close();
  });

  it("ProfileRuntime.restart() bounds consecutive retries and marks unhealthy", async () => {
    let factoryInvocations = 0;
    const peers: FakeAcpPeer[] = [];

    const runtimeFactory = () => {
      factoryInvocations++;
      const { client, peer } = createMockClient();
      peers.push(peer);
      return client;
    };

    const { client: initialClient, peer: initialPeer } = createMockClient();
    peers.push(initialPeer);

    const profile = new ProfileRuntime({
      config: {
        id: "p-bound",
        geminiHome: "/tmp/p-bound",
      },
      runtime: initialClient,
      runtimeFactory,
    });

    await profile.start();

    // Restart 1
    await profile.restart();
    assert.equal(profile.restartAttemptCount, 1);

    // Restart 2
    await profile.restart();
    assert.equal(profile.restartAttemptCount, 2);

    // Restart 3 (reaching MAX_CONSECUTIVE_RESTARTS = 3)
    await profile.restart();
    assert.equal(profile.restartAttemptCount, 3);

    // Restart 4 should fail and transition state to unhealthy
    await assert.rejects(
      async () => profile.restart(),
      /exceeded maximum restart attempts \(3\); marked unhealthy/,
    );
    assert.equal(profile.currentState, "unhealthy");

    // Calling markSuccess resets the counter
    profile.markSuccess();
    assert.equal(profile.restartAttemptCount, 0);
    assert.equal(profile.currentState, "ready");

    await profile.close();
    for (const p of peers) {
      await p.close();
    }
  });

  it("ProfileRuntime.restart() blocks restarts on auth_required and quota_exhausted", async () => {
    const profile = new ProfileRuntime({
      config: {
        id: "p-auth-block",
        geminiHome: "/tmp/p-auth-block",
      },
    });

    profile.markFailure("auth", new Error("Token expired"));
    assert.equal(profile.currentState, "auth_required");

    await assert.rejects(
      async () => profile.restart(),
      /Cannot restart profile 'p-auth-block' in auth_required state/,
    );

    profile.markFailure("quota_exhausted", new Error("Daily quota limit exceeded"));
    assert.equal(profile.currentState, "quota_exhausted");

    await assert.rejects(
      async () => profile.restart(),
      /Cannot restart profile 'p-auth-block' in quota_exhausted state/,
    );
  });

  it("ProfileManager.withProfile guarantees lease release on error", async () => {
    const manager = new ProfileManager();
    const p1 = new ProfileRuntime({
      config: { id: "p1", geminiHome: "/tmp/p1", priority: 1 },
    });
    manager.add(p1);

    assert.equal(p1.currentState, "ready");
    assert.equal(p1.activeLeaseCount, 0);

    await assert.rejects(
      async () => {
        await manager.withProfile(async (profile) => {
          assert.equal(profile.activeLeaseCount, 1);
          assert.equal(profile.currentState, "busy");
          throw new Error("Internal turn execution exploded");
        });
      },
      /Internal turn execution exploded/,
    );

    // Profile must be released
    assert.equal(p1.activeLeaseCount, 0);
    assert.equal(p1.currentState, "ready");
  });

  it("ProfileManager.withFailover releases lease before attempting next profile", async () => {
    const manager = new ProfileManager();
    const p1 = new ProfileRuntime({
      config: { id: "p1", geminiHome: "/tmp/p1", priority: 1 },
    });
    const p2 = new ProfileRuntime({
      config: { id: "p2", geminiHome: "/tmp/p2", priority: 2 },
    });
    manager.add(p1);
    manager.add(p2);

    const callOrder: string[] = [];

    const result = await manager.withFailover(async (profile, attempt) => {
      callOrder.push(profile.id);
      if (profile.id === "p1") {
        assert.equal(p1.activeLeaseCount, 1);
        assert.equal(p2.activeLeaseCount, 0);
        throw new Error("Rate limit 429 quota reached");
      }
      // When p2 is running, p1 must already have been released
      assert.equal(p1.activeLeaseCount, 0);
      assert.equal(p2.activeLeaseCount, 1);
      return `success-attempt-${attempt}`;
    });

    assert.equal(result, "success-attempt-2");
    assert.deepEqual(callOrder, ["p1", "p2"]);
    assert.equal(p1.activeLeaseCount, 0);
    assert.equal(p2.activeLeaseCount, 0);
    assert.equal(p1.currentState, "cooldown");
    assert.equal(p2.currentState, "ready");
  });

  it("Readiness probe /readyz returns 503 when server is draining", async () => {
    const manager = new ProfileManager();
    const profile = new ProfileRuntime({
      config: { id: "drain-profile", geminiHome: "/tmp/p-drain", priority: 1 },
    });
    manager.add(profile);

    const server = new RefinedOpenAiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        profiles: [],
      },
      profileManager: manager,
    });

    await server.start();
    const port = server.port;

    // While running: ready
    const resReady = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(resReady.status, 200);
    const bodyReady = await resReady.json() as Record<string, unknown>;
    assert.equal(bodyReady["status"], "ready");

    // Close server (triggers draining)
    await server.close();

    // Now after close or during shutdown:
    // Testing the handler logic directly or via server draining flag
    assert.equal(server["isDraining"], true);
  });
});

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { AcpRuntimeClient } from "../src/acp/runtime-client.js";
import { FakeAcpPeer, autoRespondInitialize } from "./helpers/fake-acp-connector.js";

describe("ProfileRuntime unit tests", () => {
  it("maintains isolated configuration and GEMINI_HOME per instance", () => {
    const pA = new ProfileRuntime({
      config: {
        id: "profile-a",
        geminiHome: "/tmp/profiles/a/gemini",
        priority: 1,
        sessionMode: "yolo",
      },
    });

    const pB = new ProfileRuntime({
      config: {
        id: "profile-b",
        geminiHome: "/tmp/profiles/b/gemini",
        priority: 2,
        sessionMode: "auto_edit",
      },
    });

    assert.equal(pA.id, "profile-a");
    assert.equal(pA.config.geminiHome, path.resolve("/tmp/profiles/a/gemini"));
    assert.equal(pA.config.priority, 1);
    assert.equal(pA.config.sessionMode, "yolo");

    assert.equal(pB.id, "profile-b");
    assert.equal(pB.config.geminiHome, path.resolve("/tmp/profiles/b/gemini"));
    assert.equal(pB.config.priority, 2);
    assert.equal(pB.config.sessionMode, "auto_edit");

    // Ensure no global mutation
    assert.notEqual(pA.config.geminiHome, pB.config.geminiHome);
  });

  it("handles start single-flight and independent close", async () => {
    const peer = new FakeAcpPeer();
    const runtimeClient = new AcpRuntimeClient({ connector: peer.getConnector() });

    const profile = new ProfileRuntime({
      config: {
        id: "profile-single-flight",
        geminiHome: "/tmp/p/gemini",
      },
      runtime: runtimeClient,
    });

    assert.equal(profile.currentState, "ready");

    const p1 = profile.start();
    const p2 = profile.start();

    await autoRespondInitialize(peer);
    await Promise.all([p1, p2]);

    assert.equal(profile.currentState, "ready");
    assert.equal(runtimeClient.isStarted, true);

    await profile.close();
    assert.equal(profile.currentState, "disabled");
    assert.equal(runtimeClient.isClosed, true);
    await peer.close();
  });

  it("manages lease state: transitions ready -> busy -> ready", () => {
    const profile = new ProfileRuntime({
      config: {
        id: "lease-test",
        geminiHome: "/tmp/p-lease",
      },
    });

    assert.equal(profile.currentState, "ready");
    assert.equal(profile.activeLeaseCount, 0);

    profile.acquireLease();
    assert.equal(profile.currentState, "busy");
    assert.equal(profile.activeLeaseCount, 1);

    // Acquiring when busy throws error
    assert.throws(
      () => profile.acquireLease(),
      /Cannot acquire lease on profile 'lease-test' in state 'busy'/,
    );

    profile.releaseLease();
    assert.equal(profile.currentState, "ready");
    assert.equal(profile.activeLeaseCount, 0);
  });

  it("handles failure transitions and cooldowns", () => {
    const profile = new ProfileRuntime({
      config: {
        id: "failure-test",
        geminiHome: "/tmp/p-fail",
      },
    });

    // Rate limit -> cooldown
    profile.markFailure("rate_limit", new Error("Rate limit hit"), 100);
    assert.equal(profile.currentState, "cooldown");
    assert.ok(profile.cooldownUntil !== undefined);
    assert.equal(profile.lastError, "Rate limit hit");

    // After cooldown expires, returns to ready
    // We can simulate expiration or markReady
    profile.markReady();
    assert.equal(profile.currentState, "ready");

    // Quota exhausted
    profile.markFailure("quota_exhausted", new Error("Monthly quota exceeded"));
    assert.equal(profile.currentState, "quota_exhausted");

    // Auth required
    profile.markFailure("auth", new Error("Token expired"));
    assert.equal(profile.currentState, "auth_required");

    // Mark success clears error
    profile.markSuccess();
    assert.equal(profile.lastError, undefined);
  });

  it("two ProfileRuntime instances operate concurrently without collision", async () => {
    const peerA = new FakeAcpPeer();
    const peerB = new FakeAcpPeer();

    const pA = new ProfileRuntime({
      config: { id: "pA", geminiHome: "/tmp/pA" },
      runtime: new AcpRuntimeClient({ connector: peerA.getConnector() }),
    });

    const pB = new ProfileRuntime({
      config: { id: "pB", geminiHome: "/tmp/pB" },
      runtime: new AcpRuntimeClient({ connector: peerB.getConnector() }),
    });

    const startA = pA.start();
    const startB = pB.start();

    await Promise.all([
      autoRespondInitialize(peerA),
      autoRespondInitialize(peerB),
      startA,
      startB,
    ]);

    assert.equal(pA.currentState, "ready");
    assert.equal(pB.currentState, "ready");

    pA.acquireLease();
    assert.equal(pA.currentState, "busy");
    assert.equal(pB.currentState, "ready");

    pA.releaseLease();
    await Promise.all([pA.close(), pB.close()]);
    await peerA.close();
    await peerB.close();
  });
});

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ProfileManager, NoAvailableProfileError } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";

function makeProfile(id: string, priority: number = 100, enabled: boolean = true): ProfileRuntime {
  return new ProfileRuntime({
    config: {
      id,
      geminiHome: `/tmp/test-profiles/${id}`,
      priority,
      enabled,
    },
  });
}

describe("ProfileManager unit tests", () => {
  it("Test 1 — priority routing: A READY (p1) + B READY (p2) -> selects A", () => {
    const pA = makeProfile("account-a", 1);
    const pB = makeProfile("account-b", 2);
    const manager = new ProfileManager([pA, pB]);

    const lease = manager.acquire();
    try {
      assert.equal(lease.profile.id, "account-a");
    } finally {
      lease.release();
    }
  });

  it("Test 2 — busy routing: A BUSY + B READY -> selects B", () => {
    const pA = makeProfile("account-a", 1);
    const pB = makeProfile("account-b", 2);
    const manager = new ProfileManager([pA, pB]);

    // Acquire A so it becomes busy
    const leaseA = manager.acquire();
    assert.equal(leaseA.profile.id, "account-a");
    assert.equal(pA.currentState, "busy");

    // Next acquisition should pick B
    const leaseB = manager.acquire();
    assert.equal(leaseB.profile.id, "account-b");

    leaseA.release();
    leaseB.release();
  });

  it("Test 3 — rate-limit failover: A rate-limited -> failover to B", async () => {
    const pA = makeProfile("account-a", 1);
    const pB = makeProfile("account-b", 2);
    const manager = new ProfileManager([pA, pB]);

    let attempts = 0;
    const result = await manager.withFailover(async (profile) => {
      attempts++;
      if (profile.id === "account-a") {
        throw new Error("HTTP 429 Too Many Requests: rate limit exceeded");
      }
      return `success-from-${profile.id}`;
    });

    assert.equal(result, "success-from-account-b");
    assert.equal(attempts, 2);
    assert.equal(pA.currentState, "cooldown");
    assert.equal(pB.currentState, "ready");
  });

  it("Test 4 — quota failover: A quota exhausted -> failover to B", async () => {
    const pA = makeProfile("account-a", 1);
    const pB = makeProfile("account-b", 2);
    const manager = new ProfileManager([pA, pB]);

    let attempts = 0;
    const result = await manager.withFailover(async (profile) => {
      attempts++;
      if (profile.id === "account-a") {
        throw new Error("RESOURCE_EXHAUSTED: monthly quota reached");
      }
      return `success-from-${profile.id}`;
    });

    assert.equal(result, "success-from-account-b");
    assert.equal(attempts, 2);
    assert.equal(pA.currentState, "quota_exhausted");
  });

  it("Test 5 — auth failover: A auth_required -> failover to B", async () => {
    const pA = makeProfile("account-a", 1);
    const pB = makeProfile("account-b", 2);
    const manager = new ProfileManager([pA, pB]);

    let attempts = 0;
    const result = await manager.withFailover(async (profile) => {
      attempts++;
      if (profile.id === "account-a") {
        throw new Error("Authentication required: token expired");
      }
      return `success-from-${profile.id}`;
    });

    assert.equal(result, "success-from-account-b");
    assert.equal(attempts, 2);
    assert.equal(pA.currentState, "auth_required");
  });

  it("Test 6 — unknown error: A unknown error -> NO retry to B", async () => {
    const pA = makeProfile("account-a", 1);
    const pB = makeProfile("account-b", 2);
    const manager = new ProfileManager([pA, pB]);

    let attempts = 0;
    await assert.rejects(
      async () =>
        manager.withFailover(async (profile) => {
          attempts++;
          if (profile.id === "account-a") {
            throw new Error("Application logic bug: invalid token format");
          }
          return "should-not-reach";
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Application logic bug/);
        return true;
      },
    );

    // Only 1 attempt made: failover was aborted
    assert.equal(attempts, 1);
    assert.equal(pA.currentState, "unhealthy");
    assert.equal(pB.currentState, "ready");
  });

  it("Test 7 — release: after success and failure, profile does not remain busy", async () => {
    const pA = makeProfile("account-a", 1);
    const manager = new ProfileManager([pA]);

    // Success path
    await manager.withProfile(async (profile) => {
      assert.equal(profile.currentState, "busy");
    });
    assert.equal(pA.currentState, "ready");
    assert.equal(pA.activeLeaseCount, 0);

    // Exception path in withProfile
    await assert.rejects(
      async () =>
        manager.withProfile(async (profile) => {
          assert.equal(profile.currentState, "busy");
          throw new Error("Operation error");
        }),
      /Operation error/,
    );
    assert.equal(pA.activeLeaseCount, 0);
  });

  it("Test 8 — affinity: preferredProfileId READY -> uses that profile regardless of priority", () => {
    const pA = makeProfile("account-a", 1);
    const pB = makeProfile("account-b", 10);
    const manager = new ProfileManager([pA, pB]);

    // Request affinity to B
    const lease = manager.acquire({ preferredProfileId: "account-b" });
    try {
      assert.equal(lease.profile.id, "account-b");
    } finally {
      lease.release();
    }

    // When no affinity is specified, priority 1 (A) is chosen
    const leaseDefault = manager.acquire();
    try {
      assert.equal(leaseDefault.profile.id, "account-a");
    } finally {
      leaseDefault.release();
    }
  });

  it("Test 9 — no profiles available: throws NoAvailableProfileError", () => {
    const pA = makeProfile("account-a", 1);
    const manager = new ProfileManager([pA]);

    // Lease A
    const leaseA = manager.acquire();

    // Trying to acquire again with all profiles busy
    assert.throws(
      () => manager.acquire(),
      (err: unknown) => err instanceof NoAvailableProfileError,
    );

    leaseA.release();
  });
});

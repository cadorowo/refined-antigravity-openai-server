import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeMetrics } from "../src/server/metrics.js";

test("RuntimeMetrics unit tests", async (t) => {
  await t.test("tracks requests, active count, and route distribution", () => {
    const metrics = new RuntimeMetrics();

    assert.equal(metrics.snapshot().requests.total, 0);
    assert.equal(metrics.snapshot().requests.active, 0);

    metrics.recordRequestStart("/v1/models");
    assert.equal(metrics.snapshot().requests.total, 1);
    assert.equal(metrics.snapshot().requests.active, 1);

    metrics.recordRequestStart("/v1/chat/completions");
    assert.equal(metrics.snapshot().requests.total, 2);
    assert.equal(metrics.snapshot().requests.active, 2);

    metrics.recordRequestEnd("/v1/models", 200, 15);
    assert.equal(metrics.snapshot().requests.active, 1);

    metrics.recordRequestEnd("/v1/chat/completions", 500, 50);
    assert.equal(metrics.snapshot().requests.active, 0);

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.requests.total, 2);
    assert.equal(snapshot.requests.errors, 1);
    assert.equal(snapshot.requests.by_route["/v1/models"], 1);
    assert.equal(snapshot.requests.by_route["/v1/chat/completions"], 1);
  });

  await t.test("tracks tokens and completion counts", () => {
    const metrics = new RuntimeMetrics();

    metrics.recordRequestStart("/v1/chat/completions");
    metrics.recordTokens(100, 25);
    metrics.recordRequestEnd("/v1/chat/completions", 200, 120);

    metrics.recordRequestStart("/v1/responses");
    metrics.recordTokens(50, 10);
    metrics.recordRequestEnd("/v1/responses", 200, 85);

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.tokens.input, 150);
    assert.equal(snapshot.tokens.output, 35);
    assert.equal(snapshot.tokens.total, 185);
    assert.equal(snapshot.completions.chat_completions, 1);
    assert.equal(snapshot.completions.responses, 1);
  });

  await t.test("tracks streams and failovers", () => {
    const metrics = new RuntimeMetrics();

    metrics.recordStreamStart();
    metrics.recordStreamStart();
    assert.equal(metrics.snapshot().streams.active, 2);

    metrics.recordStreamEnd();
    assert.equal(metrics.snapshot().streams.active, 1);

    metrics.recordStreamEnd();
    assert.equal(metrics.snapshot().streams.active, 0);

    // Prevent underflow below 0
    metrics.recordStreamEnd();
    assert.equal(metrics.snapshot().streams.active, 0);

    metrics.recordFailover(2);
    assert.equal(metrics.snapshot().requests.failovers, 2);
  });

  await t.test("tracks latency summary (count, avg, min, max, last)", () => {
    const metrics = new RuntimeMetrics();

    metrics.recordRequestStart("/v1/models");
    metrics.recordRequestEnd("/v1/models", 200, 10);

    metrics.recordRequestStart("/v1/models");
    metrics.recordRequestEnd("/v1/models", 200, 30);

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.latency.count, 2);
    assert.equal(snapshot.latency.min_ms, 10);
    assert.equal(snapshot.latency.max_ms, 30);
    assert.equal(snapshot.latency.last_ms, 30);
    assert.equal(snapshot.latency.avg_ms, 20);
  });

  await t.test("snapshot includes memory and sanitized profiles without secrets", () => {
    const metrics = new RuntimeMetrics();

    const snapshot = metrics.snapshot({
      isDraining: true,
      responseRegistryEntries: 7,
      profiles: [
        {
          id: "account-a",
          geminiHome: "/secret/path/gemini",
          priority: 1,
          enabled: true,
          sessionMode: "yolo",
          state: "ready",
          activeLeases: 0,
          lastFailureKind: undefined,
          lastError: "Some error containing token: xyz",
          lastSuccessAt: "2026-09-28T22:00:00Z",
          lastFailureAt: undefined,
        },
      ],
    });

    assert.equal(snapshot.status, "draining");
    assert.equal(snapshot.registry.responses, 7);
    assert.ok(snapshot.memory.rss_bytes > 0);
    assert.equal(snapshot.profiles.length, 1);
    assert.equal(snapshot.profiles[0]?.id, "account-a");
    assert.equal(snapshot.profiles[0]?.state, "ready");
    assert.equal(snapshot.profiles[0]?.active_leases, 0);

    // Verify secrets/paths are not present on sanitized profile status
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes("/secret/path"));
    assert.ok(!serialized.includes("geminiHome"));
    assert.ok(!serialized.includes("Some error containing token"));
  });
});

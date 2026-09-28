import assert from "node:assert/strict";
import test from "node:test";

import { ModelCatalog } from "../src/openai/models.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { ProfileRuntime } from "../src/profiles/profile-runtime.js";
import { readJsonBody } from "../src/server/request-context.js";
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

test("RefinedOpenAiServer HTTP unit tests", async (t) => {
  await t.test("GET /healthz returns ok status and profile counts without sensitive data", async () => {
    const p1 = createMockRuntime("account-a");
    const p2 = createMockRuntime("account-b");
    const manager = new ProfileManager([p1, p2]);

    const server = createServer({
      profileManager: manager,
      config: {
        host: "127.0.0.1",
        port: 0,
      },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      assert.equal(res.status, 200);

      const reqId = res.headers.get("x-request-id");
      assert.ok(reqId && /^req_[0-9a-f]{16}$/.test(reqId));

      const body = (await res.json()) as {
        status: string;
        version: string;
        uptime: number;
        profiles: Record<string, number>;
      };

      assert.equal(body.status, "ok");
      assert.equal(body.version, "0.1.0");
      assert.equal(typeof body.uptime, "number");
      assert.equal(body.profiles["total"], 2);
      assert.equal(body.profiles["ready"], 2);

      // Verify no sensitive keys leaked
      const rawText = JSON.stringify(body);
      assert.equal(rawText.includes("geminiHome"), false);
      assert.equal(rawText.includes("token"), false);
      assert.equal(rawText.includes("key"), false);
      assert.equal(rawText.includes("workspace"), false);
    } finally {
      await server.close();
    }
  });

  await t.test("GET /healthz returns degraded status when 0 profiles are available", async () => {
    const manager = new ProfileManager([]);
    const server = createServer({
      profileManager: manager,
      config: {
        host: "127.0.0.1",
        port: 0,
      },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string; profiles: Record<string, number> };
      assert.equal(body.status, "degraded");
      assert.equal(body.profiles["total"], 0);
    } finally {
      await server.close();
    }
  });

  await t.test("POST /healthz returns 405 Method Not Allowed with Allow: GET", async () => {
    const manager = new ProfileManager([]);
    const server = createServer({
      profileManager: manager,
      config: {
        host: "127.0.0.1",
        port: 0,
      },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
        method: "POST",
      });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET");
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, "method_not_allowed");
    } finally {
      await server.close();
    }
  });

  await t.test("Bearer authentication enforcement on /v1/models", async () => {
    const p1 = createMockRuntime("account-a");
    const manager = new ProfileManager([p1]);
    const apiKey = "sk-test-secret-key-123";

    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["gemini-3.8-flash"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: {
        host: "127.0.0.1",
        port: 0,
        apiKey,
      },
    });

    await server.start();
    try {
      // 1. Missing Authorization header -> 401
      const resNoAuth = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      assert.equal(resNoAuth.status, 401);
      const bodyNoAuth = (await resNoAuth.json()) as { error: { code: string; type: string } };
      assert.equal(bodyNoAuth.error.code, "invalid_api_key");
      assert.equal(bodyNoAuth.error.type, "invalid_request_error");

      // 2. Wrong API key -> 401
      const resWrongAuth = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
        headers: { Authorization: "Bearer wrong-key" },
      });
      assert.equal(resWrongAuth.status, 401);

      // 3. Valid API key -> 200
      const resOk = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resOk.status, 200);
      const list = (await resOk.json()) as { object: string; data: Array<{ id: string }> };
      assert.equal(list.object, "list");
      assert.equal(list.data[0]?.id, "gemini-3.8-flash");
    } finally {
      await server.close();
    }
  });

  await t.test("GET /v1/models and GET /v1/models/:model without API key", async () => {
    const p1 = createMockRuntime("account-a");
    const manager = new ProfileManager([p1]);

    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => ["gemini-3.8-flash", "gemini-3.7-flash"],
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: {
        host: "127.0.0.1",
        port: 0,
      },
    });

    await server.start();
    try {
      // List models
      const resList = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      assert.equal(resList.status, 200);
      const list = (await resList.json()) as {
        object: string;
        data: Array<{ id: string; object: string; created: number; owned_by: string }>;
      };
      assert.equal(list.object, "list");
      assert.equal(list.data.length, 2);
      assert.deepEqual(list.data[0], {
        id: "gemini-3.8-flash",
        object: "model",
        created: 0,
        owned_by: "antigravity",
      });

      // Existing single model
      const resSingle = await fetch(`http://127.0.0.1:${server.port}/v1/models/gemini-3.8-flash`);
      assert.equal(resSingle.status, 200);
      const single = (await resSingle.json()) as { id: string; object: string; owned_by: string };
      assert.equal(single.id, "gemini-3.8-flash");
      assert.equal(single.object, "model");
      assert.equal(single.owned_by, "antigravity");

      // Non-existing single model -> 404
      const resNotFound = await fetch(`http://127.0.0.1:${server.port}/v1/models/unknown-model`);
      assert.equal(resNotFound.status, 404);
      const notFoundBody = (await resNotFound.json()) as {
        error: { code: string; param: string | null; type: string };
      };
      assert.equal(notFoundBody.error.code, "model_not_found");
      assert.equal(notFoundBody.error.param, "model");

      // Method Not Allowed: POST /v1/models -> 405
      const resPost = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
        method: "POST",
      });
      assert.equal(resPost.status, 405);
      assert.equal(resPost.headers.get("allow"), "GET");

      // Unknown route -> 404
      const resRouteNotFound = await fetch(`http://127.0.0.1:${server.port}/v1/unknown-route-xyz`);
      assert.equal(resRouteNotFound.status, 404);
      const routeNotFoundBody = (await resRouteNotFound.json()) as { error: { code: string } };
      assert.equal(routeNotFoundBody.error.code, "route_not_found");
    } finally {
      await server.close();
    }
  });

  await t.test("Discovery failure returns 503 Service Unavailable", async () => {
    const p1 = createMockRuntime("account-a");
    const manager = new ProfileManager([p1]);

    const catalog = new ModelCatalog({
      profileManager: manager,
      discoveryFn: async () => {
        throw new Error("503 Service Unavailable");
      },
    });

    const server = createServer({
      profileManager: manager,
      modelCatalog: catalog,
      config: {
        host: "127.0.0.1",
        port: 0,
      },
    });

    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: { code: string; type: string } };
      assert.equal(body.error.code, "service_unavailable");
      assert.equal(body.error.type, "api_error");
    } finally {
      await server.close();
    }
  });

  await t.test("Graceful shutdown stops listener and is idempotent", async () => {
    const p1 = createMockRuntime("account-a");
    const manager = new ProfileManager([p1]);
    const server = createServer({
      profileManager: manager,
      config: {
        host: "127.0.0.1",
        port: 0,
      },
    });

    await server.start();
    const port = server.port;

    // Verify it is responding
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);

    // Close server
    await server.close();

    // Calling close again should not throw
    await assert.doesNotReject(() => server.close());

    // Port should no longer accept connections
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`));
  });

  await t.test("readJsonBody enforces maximum byte limit", async () => {
    const fakeReq = new (await import("node:stream")).Readable({
      read() {
        this.push(Buffer.from('{"data": "'));
        this.push(Buffer.alloc(200, "a"));
        this.push(Buffer.from('"}'));
        this.push(null);
      },
    }) as unknown as import("node:http").IncomingMessage;

    await assert.rejects(
      () => readJsonBody(fakeReq, 50),
      (err: unknown) =>
        err instanceof Error &&
        "statusCode" in err &&
        (err as { statusCode: number }).statusCode === 413,
    );
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeLogString,
  sanitizeLogContext,
  DefaultServerLogger,
  NoopServerLogger,
} from "../src/server/logger.js";

test("Logger and Redaction unit tests", async (t) => {
  await t.test("sanitizeLogString redacts Bearer tokens", () => {
    const raw = "Authorization: Bearer my-super-secret-token-123456";
    const sanitized = sanitizeLogString(raw);
    assert.ok(!sanitized.includes("my-super-secret-token-123456"));
    assert.ok(sanitized.includes("Bearer [REDACTED]"));
  });

  await t.test("sanitizeLogString redacts sk-... API keys", () => {
    const raw = "Using key sk-proj-1234567890abcdef for request";
    const sanitized = sanitizeLogString(raw);
    assert.ok(!sanitized.includes("1234567890abcdef"));
    assert.ok(sanitized.includes("sk-[REDACTED]"));
  });

  await t.test("sanitizeLogString redacts acp_token.json file names", () => {
    const raw = "Reading token from /home/user/.gemini/antigravity/acp_token.json";
    const sanitized = sanitizeLogString(raw);
    assert.ok(!sanitized.includes("acp_token.json"));
    assert.ok(sanitized.includes("[REDACTED_TOKEN_FILE]"));
  });

  await t.test("sanitizeLogString redacts sensitive filesystem paths with credentials/oauth", () => {
    const raw = "Found profile at /Users/alice/.config/refined-agy/profiles/account-a/oauth_creds.json";
    const sanitized = sanitizeLogString(raw);
    assert.ok(!sanitized.includes("oauth_creds.json"));
    assert.ok(sanitized.includes("[REDACTED_PATH]"));
  });

  await t.test("sanitizeLogContext redacts sensitive keys in objects", () => {
    const context = {
      requestId: "req_123",
      authorization: "Bearer secret-val",
      apiKey: "sk-secret-key-123",
      token: "raw-token-abc",
      password: "secretpassword",
      secret: "shhh",
      prompt: "This is a secret prompt containing PII",
      instructions: "Do not tell anyone",
      cookies: "session=12345",
      nested: {
        normalField: "public-value",
        token: "nested-token",
        mixedString: "Bearer token-in-string",
      },
    };

    const sanitized = sanitizeLogContext(context) as Record<string, unknown>;
    assert.equal(sanitized["requestId"], "req_123");
    assert.equal(sanitized["authorization"], "[REDACTED]");
    assert.equal(sanitized["apiKey"], "[REDACTED]");
    assert.equal(sanitized["token"], "[REDACTED]");
    assert.equal(sanitized["password"], "[REDACTED]");
    assert.equal(sanitized["secret"], "[REDACTED]");
    assert.equal(sanitized["prompt"], "[REDACTED]");
    assert.equal(sanitized["instructions"], "[REDACTED]");
    assert.equal(sanitized["cookies"], "[REDACTED]");

    const nested = sanitized["nested"] as Record<string, unknown>;
    assert.equal(nested["normalField"], "public-value");
    assert.equal(nested["token"], "[REDACTED]");
    assert.equal(nested["mixedString"], "Bearer [REDACTED]");
  });

  await t.test("sanitizeLogContext handles arrays and primitive types", () => {
    const list = [
      "sk-123456789",
      { apiKey: "secret" },
      42,
      true,
      null,
      undefined,
    ];
    const sanitized = sanitizeLogContext(list) as Array<unknown>;
    assert.equal(sanitized[0], "sk-[REDACTED]");
    assert.deepEqual(sanitized[1], { apiKey: "[REDACTED]" });
    assert.equal(sanitized[2], 42);
    assert.equal(sanitized[3], true);
    assert.equal(sanitized[4], null);
    assert.equal(sanitized[5], undefined);
  });

  await t.test("sanitizeLogContext sanitizes Error objects", () => {
    const err = new Error("Failed connecting with token sk-9876543210");
    const sanitized = sanitizeLogContext(err) as { name: string; message: string; stack?: string };
    assert.equal(sanitized.name, "Error");
    assert.ok(!sanitized.message.includes("9876543210"));
    assert.ok(sanitized.message.includes("sk-[REDACTED]"));
    if (sanitized.stack) {
      assert.ok(!sanitized.stack.includes("9876543210"));
    }
  });

  await t.test("sanitizeLogContext stops at recursion limit", () => {
    interface RecursiveObj {
      self?: RecursiveObj;
    }
    const deep: RecursiveObj = {};
    let curr: RecursiveObj = deep;
    for (let i = 0; i < 15; i++) {
      const next: RecursiveObj = {};
      curr.self = next;
      curr = next;
    }
    const sanitized = sanitizeLogContext(deep);
    assert.ok(sanitized !== undefined);
  });

  await t.test("DefaultServerLogger logs without throwing", () => {
    const logger = new DefaultServerLogger();
    // In test environment, info/warn/error console output is muted or suppressed
    logger.debug("Debug msg sk-123456789", { token: "secret" });
    logger.info("Info msg Bearer token", { authorization: "Bearer xyz" });
    logger.warn("Warn msg", { apiKey: "key" });
    logger.error("Error msg", new Error("sk-test123456"), { prompt: "text" });
  });

  await t.test("NoopServerLogger does nothing", () => {
    const logger = new NoopServerLogger();
    logger.debug("test");
    logger.info("test");
    logger.warn("test");
    logger.error("test");
  });
});

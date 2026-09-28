import assert from "node:assert/strict";
import test from "node:test";

import { verifyBearerAuth } from "../src/server/auth.js";

test("verifyBearerAuth unit tests", async (t) => {
  await t.test("allows any request when server has no API key configured", () => {
    assert.equal(verifyBearerAuth(undefined, undefined), true);
    assert.equal(verifyBearerAuth("Bearer whatever", undefined), true);
    assert.equal(verifyBearerAuth(undefined, ""), true);
    assert.equal(verifyBearerAuth("Bearer whatever", ""), true);
  });

  await t.test("rejects missing or malformed header when API key is configured", () => {
    const expected = "sk-antigravity-secret";
    assert.equal(verifyBearerAuth(undefined, expected), false);
    assert.equal(verifyBearerAuth("", expected), false);
    assert.equal(verifyBearerAuth("Basic dXNlcjpwYXNz", expected), false);
    assert.equal(verifyBearerAuth("Bearer ", expected), false);
    assert.equal(verifyBearerAuth("Token " + expected, expected), false);
  });

  await t.test("rejects incorrect token or different length safely", () => {
    const expected = "sk-antigravity-secret";
    assert.equal(verifyBearerAuth("Bearer wrong-token", expected), false);
    assert.equal(verifyBearerAuth("Bearer sk-antigravity-short", expected), false);
    assert.equal(verifyBearerAuth("Bearer sk-antigravity-secret-longer", expected), false);
  });

  await t.test("accepts matching token with Bearer prefix", () => {
    const expected = "sk-antigravity-secret-123";
    assert.equal(verifyBearerAuth(`Bearer ${expected}`, expected), true);
    assert.equal(verifyBearerAuth(`bearer ${expected}`, expected), true);
    assert.equal(verifyBearerAuth(`Bearer   ${expected}  `, expected), true);
  });
});

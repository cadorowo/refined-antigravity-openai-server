import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyProfileFailure } from "../src/profiles/failure-classifier.js";
import { AcpRequestError } from "../src/acp/errors.js";

describe("FailureClassifier unit tests", () => {
  it("classifies rate limit errors with cooldown and retryable = true", () => {
    const err1 = new Error("Rate limit exceeded. Please wait 60s.");
    const c1 = classifyProfileFailure(err1);
    assert.equal(c1.kind, "rate_limit");
    assert.equal(c1.retryableOnAnotherProfile, true);
    assert.equal(c1.cooldownMs, 60_000);

    const err2 = new AcpRequestError("Too many requests (429)", -32000);
    const c2 = classifyProfileFailure(err2);
    assert.equal(c2.kind, "rate_limit");
    assert.equal(c2.retryableOnAnotherProfile, true);
  });

  it("classifies quota exhaustion as quota_exhausted and retryable = true", () => {
    const err1 = new Error("RESOURCE_EXHAUSTED: Daily token limit reached");
    const c1 = classifyProfileFailure(err1);
    assert.equal(c1.kind, "quota_exhausted");
    assert.equal(c1.retryableOnAnotherProfile, true);

    const err2 = new AcpRequestError("User quota exceeded for model", -32000);
    const c2 = classifyProfileFailure(err2);
    assert.equal(c2.kind, "quota_exhausted");
    assert.equal(c2.retryableOnAnotherProfile, true);
  });

  it("classifies authentication failures as auth and retryable = true", () => {
    const err1 = new Error("Authentication required: Please log in with Google");
    const c1 = classifyProfileFailure(err1);
    assert.equal(c1.kind, "auth");
    assert.equal(c1.retryableOnAnotherProfile, true);

    const err2 = new AcpRequestError("HTTP 401 Unauthorized: token expired", 401);
    const c2 = classifyProfileFailure(err2);
    assert.equal(c2.kind, "auth");
    assert.equal(c2.retryableOnAnotherProfile, true);
  });

  it("classifies transient server/network errors as transient with cooldown", () => {
    const err1 = new Error("HTTP 503 Service Unavailable");
    const c1 = classifyProfileFailure(err1);
    assert.equal(c1.kind, "transient");
    assert.equal(c1.retryableOnAnotherProfile, true);
    assert.equal(c1.cooldownMs, 15_000);

    const err2 = new Error("read ECONNRESET: connection reset by peer");
    const c2 = classifyProfileFailure(err2);
    assert.equal(c2.kind, "transient");
    assert.equal(c2.retryableOnAnotherProfile, true);
  });

  it("classifies unknown/fatal errors as fatal with retryable = false", () => {
    const err1 = new Error("SyntaxError: Unexpected token < in JSON");
    const c1 = classifyProfileFailure(err1);
    assert.equal(c1.kind, "fatal");
    assert.equal(c1.retryableOnAnotherProfile, false);

    const err2 = new AcpRequestError("Invalid parameter: sessionId not found", -32602);
    const c2 = classifyProfileFailure(err2);
    assert.equal(c2.kind, "fatal");
    assert.equal(c2.retryableOnAnotherProfile, false);
  });
});

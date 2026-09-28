import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CallbackPermissionHandler,
  PolicyPermissionHandler,
  createPermissionHandler,
  type PermissionRequest,
} from "../src/acp/permission-handler.js";
import { PermissionDecisionError } from "../src/acp/errors.js";

describe("PermissionHandler unit tests", () => {
  it("reject policy selects reject_once when available", async () => {
    const handler = new PolicyPermissionHandler("reject");
    const request: PermissionRequest = {
      sessionId: "sess-1",
      toolCall: { toolCallId: "t1", kind: "execute", title: "Run pwd" },
      options: [
        { optionId: "opt-allow", kind: "allow_once", name: "Allow" },
        { optionId: "opt-deny", kind: "reject_once", name: "Deny" },
      ],
    };

    const decision = await handler.decide(request);
    assert.deepEqual(decision, {
      outcome: { outcome: "selected", optionId: "opt-deny" },
    });
  });

  it("reject policy selects reject_always if reject_once is not available", async () => {
    const handler = new PolicyPermissionHandler("reject");
    const request: PermissionRequest = {
      sessionId: "sess-1",
      options: [
        { optionId: "opt-allow", kind: "allow_once" },
        { optionId: "opt-block-forever", kind: "reject_always" },
      ],
    };

    const decision = await handler.decide(request);
    assert.deepEqual(decision, {
      outcome: { outcome: "selected", optionId: "opt-block-forever" },
    });
  });

  it("reject policy returns cancelled outcome if no reject option is offered", async () => {
    const handler = new PolicyPermissionHandler("reject");
    const request: PermissionRequest = {
      sessionId: "sess-1",
      options: [{ optionId: "opt-allow", kind: "allow_once" }],
    };

    const decision = await handler.decide(request);
    assert.deepEqual(decision, {
      outcome: { outcome: "cancelled" },
    });
  });

  it("allow-once policy selects allow_once option by kind", async () => {
    const handler = new PolicyPermissionHandler("allow-once");
    const request: PermissionRequest = {
      sessionId: "sess-1",
      toolCall: { toolCallId: "t2", kind: "edit" },
      options: [
        { optionId: "custom-allow-id", kind: "allow_once" },
        { optionId: "custom-deny-id", kind: "reject_once" },
      ],
    };

    const decision = await handler.decide(request);
    assert.deepEqual(decision, {
      outcome: { outcome: "selected", optionId: "custom-allow-id" },
    });
  });

  it("allow-once policy throws PermissionDecisionError when allow_once is missing", async () => {
    const handler = new PolicyPermissionHandler("allow-once");
    const request: PermissionRequest = {
      sessionId: "sess-1",
      options: [{ optionId: "deny-id", kind: "reject_once" }],
    };

    await assert.rejects(
      async () => handler.decide(request),
      (err: unknown) => err instanceof PermissionDecisionError,
    );
  });

  it("allow-always policy selects allow_always when available", async () => {
    const handler = new PolicyPermissionHandler("allow-always");
    const request: PermissionRequest = {
      sessionId: "sess-1",
      options: [
        { optionId: "always-id", kind: "allow_always" },
        { optionId: "once-id", kind: "allow_once" },
        { optionId: "deny-id", kind: "reject_once" },
      ],
    };

    const decision = await handler.decide(request);
    assert.deepEqual(decision, {
      outcome: { outcome: "selected", optionId: "always-id" },
    });
  });

  it("allow-always policy falls back to allow_once if allow_always is missing and fallback is enabled", async () => {
    const handler = new PolicyPermissionHandler({ policy: "allow-always", fallbackToAllowOnce: true });
    const request: PermissionRequest = {
      sessionId: "sess-1",
      options: [
        { optionId: "once-id", kind: "allow_once" },
        { optionId: "deny-id", kind: "reject_once" },
      ],
    };

    const decision = await handler.decide(request);
    assert.deepEqual(decision, {
      outcome: { outcome: "selected", optionId: "once-id" },
    });
  });

  it("allow-always policy throws when allow_always is missing and fallback is disabled", async () => {
    const handler = new PolicyPermissionHandler({ policy: "allow-always", fallbackToAllowOnce: false });
    const request: PermissionRequest = {
      sessionId: "sess-1",
      options: [{ optionId: "once-id", kind: "allow_once" }],
    };

    await assert.rejects(
      async () => handler.decide(request),
      (err: unknown) => err instanceof PermissionDecisionError,
    );
  });

  it("custom CallbackPermissionHandler delegates properly", async () => {
    let calledWith: PermissionRequest | null = null;
    const handler = new CallbackPermissionHandler((req) => {
      calledWith = req;
      return { outcome: { outcome: "selected", optionId: "custom" } };
    });

    const request: PermissionRequest = {
      sessionId: "sess-cb",
      options: [{ optionId: "custom", kind: "allow_once" }],
    };

    const decision = await handler.decide(request);
    assert.equal(decision.outcome.outcome, "selected");
    assert.equal(calledWith, request);
  });

  it("createPermissionHandler normalizes string policy or instance", () => {
    const h1 = createPermissionHandler("reject");
    assert.ok(h1 instanceof PolicyPermissionHandler);
    const custom = new CallbackPermissionHandler(() => ({ outcome: { outcome: "cancelled" } }));
    const h2 = createPermissionHandler(custom);
    assert.equal(h2, custom);
  });
});

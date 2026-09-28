import assert from "node:assert/strict";
import test from "node:test";

import { validateChatCompletionRequest } from "../src/openai/chat-validator.js";
import { OpenAIHttpError } from "../src/openai/errors.js";

test("validateChatCompletionRequest unit tests", async (t) => {
  await t.test("accepts valid basic request", () => {
    const req = validateChatCompletionRequest({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "Hello" }],
    });
    assert.equal(req.model, "gemini-3.8-flash");
    assert.equal(req.messages.length, 1);
    assert.equal(req.stream, false);
  });

  await t.test("accepts text parts array in content", () => {
    const req = validateChatCompletionRequest({
      model: "gemini-3.8-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "part 1" },
            { type: "text", text: " part 2" },
          ],
        },
      ],
    });
    assert.equal(req.messages.length, 1);
  });

  await t.test("accepts valid reasoning_effort and stream_options", () => {
    const req = validateChatCompletionRequest({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      reasoning_effort: "high",
      stream_options: { include_usage: true },
    });
    assert.equal(req.stream, true);
    assert.equal(req.reasoning_effort, "high");
    assert.equal(req.stream_options?.include_usage, true);
  });

  await t.test("rejects missing model", () => {
    assert.throws(
      () =>
        validateChatCompletionRequest({
          messages: [{ role: "user", content: "Hello" }],
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "missing_required_parameter" &&
        err.param === "model",
    );
  });

  await t.test("rejects empty or non-array messages", () => {
    assert.throws(
      () =>
        validateChatCompletionRequest({
          model: "gemini-3.8-flash",
          messages: [],
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "invalid_value" &&
        err.param === "messages",
    );

    assert.throws(
      () =>
        validateChatCompletionRequest({
          model: "gemini-3.8-flash",
          messages: "not-an-array",
        }),
      (err: unknown) => err instanceof OpenAIHttpError && err.statusCode === 400,
    );
  });

  await t.test("rejects invalid role", () => {
    assert.throws(
      () =>
        validateChatCompletionRequest({
          model: "gemini-3.8-flash",
          messages: [{ role: "admin", content: "Hello" }],
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "invalid_value" &&
        err.param === "messages[0].role",
    );
  });

  await t.test("rejects non-text content types (e.g. image_url, input_audio)", () => {
    assert.throws(
      () =>
        validateChatCompletionRequest({
          model: "gemini-3.8-flash",
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "http://example.com/img.png" } }],
            },
          ],
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.message.includes("Only text content is supported"),
    );
  });

  await t.test("rejects invalid reasoning_effort", () => {
    assert.throws(
      () =>
        validateChatCompletionRequest({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "Hello" }],
          reasoning_effort: "maximum",
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "invalid_value" &&
        err.param === "reasoning_effort",
    );
  });

  await t.test("rejects unsupported OpenAI parameters", () => {
    const unsupportedList = ["temperature", "top_p", "tools", "functions", "n", "seed"];
    for (const param of unsupportedList) {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: "gemini-3.8-flash",
            messages: [{ role: "user", content: "Hello" }],
            [param]: 0.7,
          }),
        (err: unknown) =>
          err instanceof OpenAIHttpError &&
          err.statusCode === 400 &&
          err.code === "unsupported_parameter" &&
          err.param === param,
      );
    }
  });

  await t.test("rejects client workspace / cwd parameters", () => {
    assert.throws(
      () =>
        validateChatCompletionRequest({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "Hello" }],
          workspace: "/etc/passwd",
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "unsupported_parameter",
    );
  });

  await t.test("rejects non-boolean stream", () => {
    assert.throws(
      () =>
        validateChatCompletionRequest({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "Hello" }],
          stream: "true",
        }),
      (err: unknown) => err instanceof OpenAIHttpError && err.statusCode === 400,
    );
  });
});

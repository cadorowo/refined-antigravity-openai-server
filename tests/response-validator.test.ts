import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIHttpError } from "../src/openai/errors.js";
import { validateResponseCreateRequest } from "../src/openai/response-validator.js";

test("Responses API validator unit tests", async (t) => {
  await t.test("accepts valid string input", () => {
    const validated = validateResponseCreateRequest({
      model: "gemini-3.8-flash",
      input: "Hello world!",
    });

    assert.equal(validated.model, "gemini-3.8-flash");
    assert.equal(validated.input, "Hello world!");
    assert.equal(validated.stream, false);
    assert.equal(validated.store, true);
  });

  await t.test("accepts valid message array input", () => {
    const validated = validateResponseCreateRequest({
      model: "gemini-3.8-flash",
      input: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Tell me a story." },
      ],
      stream: true,
      store: false,
    });

    assert.equal(validated.model, "gemini-3.8-flash");
    assert.equal(validated.stream, true);
    assert.equal(validated.store, false);
    assert.ok(Array.isArray(validated.input));
    assert.equal(validated.input.length, 2);
  });

  await t.test("accepts content parts with type input_text and text", () => {
    const validated = validateResponseCreateRequest({
      model: "gemini-3.8-flash",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ],
    });

    assert.ok(Array.isArray(validated.input));
    const first = validated.input[0] as any;
    assert.equal(first.role, "user");
    assert.equal(first.content.length, 2);
  });

  await t.test("accepts top-level instructions and previous_response_id", () => {
    const validated = validateResponseCreateRequest({
      model: "gemini-3.8-flash",
      input: "What next?",
      instructions: "Be brief.",
      previous_response_id: "resp_1234567890abcdef",
    });

    assert.equal(validated.instructions, "Be brief.");
    assert.equal(validated.previous_response_id, "resp_1234567890abcdef");
  });

  await t.test("accepts valid reasoning config and reasoning_effort", () => {
    const res1 = validateResponseCreateRequest({
      model: "gemini-3.8-flash",
      input: "Think deeply",
      reasoning: { effort: "high" },
    });
    assert.equal(res1.reasoning?.effort, "high");

    const res2 = validateResponseCreateRequest({
      model: "gemini-3.8-flash",
      input: "Think fast",
      reasoning_effort: "low",
    });
    assert.equal(res2.reasoning_effort, "low");
  });

  await t.test("accepts valid metadata object", () => {
    const validated = validateResponseCreateRequest({
      model: "gemini-3.8-flash",
      input: "Test metadata",
      metadata: {
        userId: "user_123",
        environment: "production",
      },
    });

    assert.deepEqual(validated.metadata, {
      userId: "user_123",
      environment: "production",
    });
  });

  await t.test("rejects missing model", () => {
    assert.throws(
      () => validateResponseCreateRequest({ input: "Hello" }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "missing_required_parameter" &&
        err.param === "model",
    );
  });

  await t.test("rejects missing or empty input", () => {
    assert.throws(
      () => validateResponseCreateRequest({ model: "gemini-3.8-flash" }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "missing_required_parameter" &&
        err.param === "input",
    );

    assert.throws(
      () => validateResponseCreateRequest({ model: "gemini-3.8-flash", input: [] }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "invalid_value" &&
        err.param === "input",
    );
  });

  await t.test("rejects unsupported content parts (e.g. input_image, input_audio)", () => {
    assert.throws(
      () =>
        validateResponseCreateRequest({
          model: "gemini-3.8-flash",
          input: [
            {
              role: "user",
              content: [{ type: "input_image", image_url: "https://example.com/img.png" }],
            },
          ],
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "unsupported_content_type",
    );
  });

  await t.test("rejects unsupported item types (e.g. function_call)", () => {
    assert.throws(
      () =>
        validateResponseCreateRequest({
          model: "gemini-3.8-flash",
          input: [
            {
              type: "function_call",
              name: "my_tool",
            },
          ],
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "unsupported_item_type",
    );
  });

  await t.test("rejects invalid reasoning effort", () => {
    assert.throws(
      () =>
        validateResponseCreateRequest({
          model: "gemini-3.8-flash",
          input: "Test",
          reasoning: { effort: "turbo" },
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "unsupported_value" &&
        err.param === "reasoning.effort",
    );
  });

  await t.test("rejects unsupported parameters (tools, background, conversation, max_output_tokens)", () => {
    assert.throws(
      () =>
        validateResponseCreateRequest({
          model: "gemini-3.8-flash",
          input: "Test",
          tools: [{ type: "function" }],
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "unsupported_parameter" &&
        err.param === "tools",
    );

    assert.throws(
      () =>
        validateResponseCreateRequest({
          model: "gemini-3.8-flash",
          input: "Test",
          background: true,
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "unsupported_parameter" &&
        err.param === "background",
    );

    assert.throws(
      () =>
        validateResponseCreateRequest({
          model: "gemini-3.8-flash",
          input: "Test",
          max_output_tokens: 100,
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "unsupported_parameter" &&
        err.param === "max_output_tokens",
    );
  });

  await t.test("rejects metadata with excessive length or non-string values", () => {
    assert.throws(
      () =>
        validateResponseCreateRequest({
          model: "gemini-3.8-flash",
          input: "Test",
          metadata: {
            ["k".repeat(65)]: "value",
          },
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "invalid_value",
    );

    assert.throws(
      () =>
        validateResponseCreateRequest({
          model: "gemini-3.8-flash",
          input: "Test",
          metadata: {
            validKey: 12345 as any,
          },
        }),
      (err: unknown) =>
        err instanceof OpenAIHttpError &&
        err.statusCode === 400 &&
        err.code === "invalid_value",
    );
  });
});

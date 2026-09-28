import assert from "node:assert/strict";
import test from "node:test";

import {
  convertOpenAiMessages,
  extractTextContent,
  serializeConversation,
} from "../src/openai/message-converter.js";

test("message-converter unit tests", async (t) => {
  await t.test("extractTextContent extracts from string and parts", () => {
    assert.equal(extractTextContent("simple text"), "simple text");
    assert.equal(
      extractTextContent([
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ]),
      "hello world",
    );
  });

  await t.test("single user message serializes directly without extra headers", () => {
    const serialized = serializeConversation([{ role: "user", content: "Tell me a joke" }]);
    assert.equal(serialized, "Tell me a joke");
  });

  await t.test("separates system and developer instructions from conversation", () => {
    const converted = convertOpenAiMessages([
      { role: "system", content: "You are a helpful assistant." },
      { role: "developer", content: "Formatting guidelines: markdown." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "How are you?" },
    ]);

    assert.deepEqual(converted.systemInstructions, [
      "You are a helpful assistant.",
      "Formatting guidelines: markdown.",
    ]);
    assert.equal(converted.conversation.length, 3);
    assert.equal(converted.conversation[0]?.role, "user");
    assert.equal(converted.conversation[1]?.role, "assistant");
    assert.equal(converted.conversation[2]?.role, "user");
  });

  await t.test("serializes multi-turn conversation preserving order and distinct sections", () => {
    const serialized = serializeConversation([
      { role: "system", content: "Act as a math tutor." },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 equals 4." },
      { role: "user", content: "And 4*4?" },
    ]);

    assert.ok(serialized.includes("[System Instructions]"));
    assert.ok(serialized.includes("Act as a math tutor."));
    assert.ok(serialized.includes("[Conversation History]"));
    assert.ok(serialized.includes("User:\nWhat is 2+2?"));
    assert.ok(serialized.includes("Assistant:\n2+2 equals 4."));
    assert.ok(serialized.includes("User:\nAnd 4*4?"));

    // Verify ordering
    const idxSystem = serialized.indexOf("[System Instructions]");
    const idxTurn1 = serialized.indexOf("What is 2+2?");
    const idxTurn2 = serialized.indexOf("2+2 equals 4.");
    const idxTurn3 = serialized.indexOf("And 4*4?");

    assert.ok(idxSystem < idxTurn1);
    assert.ok(idxTurn1 < idxTurn2);
    assert.ok(idxTurn2 < idxTurn3);
  });

  await t.test("serializes system instruction with single user prompt cleanly", () => {
    const serialized = serializeConversation([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Explain gravity." },
    ]);

    assert.ok(serialized.includes("[System Instructions]\nBe concise."));
    assert.ok(serialized.includes("[User Prompt]\nExplain gravity."));
  });
});

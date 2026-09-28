import assert from "node:assert/strict";
import test from "node:test";

import {
  extractResponseTextContent,
  parseCurrentRequestInput,
  reconstructResponseContext,
} from "../src/openai/response-converter.js";
import type { ResponseRecord } from "../src/openai/response-registry.js";

test("Response context reconstruction and instructions isolation unit tests", async (t) => {
  await t.test("extractResponseTextContent handles strings and parts", () => {
    assert.equal(extractResponseTextContent("simple text"), "simple text");
    assert.equal(
      extractResponseTextContent([
        { type: "input_text", text: "part 1 " },
        { type: "text", text: "part 2" },
      ]),
      "part 1 part 2",
    );
  });

  await t.test("parseCurrentRequestInput separates instructions and turns", () => {
    const { systemInstructions, conversationTurns } = parseCurrentRequestInput(
      [
        { role: "developer", content: "Developer instruction" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "system", content: "System instruction" },
      ],
      "Top-level instruction",
    );

    assert.equal(systemInstructions.length, 3);
    assert.ok(systemInstructions.includes("Top-level instruction"));
    assert.ok(systemInstructions.includes("Developer instruction"));
    assert.ok(systemInstructions.includes("System instruction"));

    assert.equal(conversationTurns.length, 2);
    assert.equal(conversationTurns[0]!.role, "user");
    assert.equal(conversationTurns[0]!.content, "Hello");
    assert.equal(conversationTurns[1]!.role, "assistant");
    assert.equal(conversationTurns[1]!.content, "Hi");
  });

  await t.test("first response with simple string returns user content directly", () => {
    const { promptText, newTranscript } = reconstructResponseContext({
      input: "What is 2+2?",
    });

    assert.equal(promptText, "What is 2+2?");
    assert.equal(newTranscript.length, 1);
    assert.equal(newTranscript[0]!.role, "user");
    assert.equal(newTranscript[0]!.content, "What is 2+2?");
  });


  await t.test("first response with instructions serializes sections cleanly", () => {
    const { promptText, newTranscript } = reconstructResponseContext({
      input: "What is 2+2?",
      instructions: "Reply in Roman numerals.",
    });

    assert.ok(promptText.includes("[System Instructions]\nReply in Roman numerals."));
    assert.ok(promptText.includes("[User Prompt]\nWhat is 2+2?"));
    assert.equal(newTranscript.length, 1);
  });

  await t.test("continuation reconstructs previous transcript and preserves order", () => {
    const record1: ResponseRecord = {
      id: "resp_1",
      createdAt: 100,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws",
      transcript: [
        { role: "user", content: "My name is Alice." },
        { role: "assistant", content: "Hello Alice! Nice to meet you." },
      ],
      outputText: "Hello Alice! Nice to meet you.",
      status: "completed",
      store: true,
    };

    const { promptText, newTranscript } = reconstructResponseContext({
      input: "What is my name?",
      previousRecord: record1,
    });

    assert.equal(newTranscript.length, 3);
    assert.equal(newTranscript[0]!.role, "user");
    assert.equal(newTranscript[0]!.content, "My name is Alice.");
    assert.equal(newTranscript[1]!.role, "assistant");
    assert.equal(newTranscript[1]!.content, "Hello Alice! Nice to meet you.");
    assert.equal(newTranscript[2]!.role, "user");
    assert.equal(newTranscript[2]!.content, "What is my name?");

    assert.ok(promptText.includes("[Conversation History]"));
    assert.ok(promptText.includes("User:\nMy name is Alice."));
    assert.ok(promptText.includes("Assistant:\nHello Alice! Nice to meet you."));
    assert.ok(promptText.includes("User:\nWhat is my name?"));
  });

  await t.test("second continuation preserves full multi-turn conversation", () => {
    const record2: ResponseRecord = {
      id: "resp_2",
      createdAt: 101,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws",
      transcript: [
        { role: "user", content: "Turn 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Turn 2" },
        { role: "assistant", content: "Reply 2" },
      ],
      outputText: "Reply 2",
      status: "completed",
      store: true,
    };

    const { promptText, newTranscript } = reconstructResponseContext({
      input: "Turn 3",
      previousRecord: record2,
    });

    assert.equal(newTranscript.length, 5);
    assert.equal(newTranscript[4]!.content, "Turn 3");

    assert.ok(promptText.includes("Turn 1"));
    assert.ok(promptText.includes("Reply 1"));
    assert.ok(promptText.includes("Turn 2"));
    assert.ok(promptText.includes("Reply 2"));
    assert.ok(promptText.includes("Turn 3"));
  });

  await t.test("CRITICAL: old instructions from previous response are NEVER carried over", () => {
    // Response 1 was created with instructions: "Speak like a pirate: Ahoy matey!"
    const record1: ResponseRecord = {
      id: "resp_pirate_1",
      createdAt: 100,
      lastAccessedAt: Date.now(),
      model: "gemini-3.8-flash",
      workspace: "/tmp/ws",
      transcript: [
        { role: "user", content: "Where is the treasure?" },
        { role: "assistant", content: "Ahoy matey! On Skull Island." },
      ],
      outputText: "Ahoy matey! On Skull Island.",
      instructions: "Speak like a pirate: Ahoy matey!",
      status: "completed",
      store: true,
    };

    // Response 2 continuation: no instructions provided
    const resNoInstructions = reconstructResponseContext({
      input: "Can we go now?",
      previousRecord: record1,
    });

    // The old instruction MUST NOT be in promptText
    assert.equal(
      resNoInstructions.promptText.includes("Speak like a pirate"),
      false,
      "Old instructions must not be replayed when instructions are omitted",
    );
    assert.equal(
      resNoInstructions.promptText.includes("[System Instructions]"),
      false,
      "No system instructions header should exist when instructions are omitted",
    );

    // Response 2 continuation: with NEW instruction "Speak like a robot"
    const resNewInstructions = reconstructResponseContext({
      input: "Can we go now?",
      instructions: "Speak like a robot: BEEP BOOP.",
      previousRecord: record1,
    });

    assert.ok(resNewInstructions.promptText.includes("Speak like a robot: BEEP BOOP."));
    assert.equal(
      resNewInstructions.promptText.includes("Speak like a pirate"),
      false,
      "Old instructions must not be replayed when new instructions are provided",
    );
  });

  await t.test("current instructions are included exactly once", () => {
    const { promptText } = reconstructResponseContext({
      input: [
        { role: "developer", content: "Instruction A" },
        { role: "user", content: "Hello" },
      ],
      instructions: "Instruction A", // duplicate of input developer message
    });

    const matches = promptText.match(/Instruction A/g);
    assert.equal(matches?.length, 1, "Duplicate instructions should be deduped to appear exactly once");
  });
});

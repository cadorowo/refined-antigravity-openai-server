import type {
  ChatCompletionContentPart,
  ChatCompletionMessageInput,
} from "./types.js";

export interface ConvertedMessages {
  systemInstructions: string[];
  conversation: Array<{
    role: "user" | "assistant";
    content: string;
    name?: string | undefined;
  }>;
}

/**
 * Extracts plain text from a message content field (string or array of text parts).
 */
export function extractTextContent(content: string | ChatCompletionContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
}

/**
 * Categorizes OpenAI messages into system instructions (system + developer)
 * and ordered conversation history (user + assistant).
 */
export function convertOpenAiMessages(messages: ChatCompletionMessageInput[]): ConvertedMessages {
  const systemInstructions: string[] = [];
  const conversation: Array<{
    role: "user" | "assistant";
    content: string;
    name?: string | undefined;
  }> = [];

  for (const msg of messages) {
    const text = extractTextContent(msg.content);
    if (msg.role === "system" || msg.role === "developer") {
      if (text.trim().length > 0) {
        systemInstructions.push(text.trim());
      }
    } else if (msg.role === "user" || msg.role === "assistant") {
      conversation.push({
        role: msg.role,
        content: text,
        ...(msg.name ? { name: msg.name } : {}),
      });
    }
  }

  return { systemInstructions, conversation };
}

/**
 * Serializes the conversation into an unambiguous text prompt suitable for AGY.
 *
 * Rules:
 * 1. Single user prompt with no system instructions returns the user text directly.
 * 2. Multi-turn or system-guided conversations are serialized with clear, unambiguous sections.
 * 3. System/developer instructions are gathered at the top and never duplicated.
 * 4. Message order is strictly preserved.
 */
export function serializeConversation(messages: ChatCompletionMessageInput[]): string {
  const { systemInstructions, conversation } = convertOpenAiMessages(messages);

  // Case 1: Simple single user message with no system instructions
  if (systemInstructions.length === 0 && conversation.length === 1 && conversation[0]?.role === "user") {
    return conversation[0].content;
  }

  const sections: string[] = [];

  // Add system / developer instructions if present
  if (systemInstructions.length > 0) {
    sections.push(`[System Instructions]\n${systemInstructions.join("\n\n")}`);
  }

  // Add conversation history
  if (conversation.length > 0) {
    if (conversation.length === 1 && conversation[0]?.role === "user") {
      sections.push(`[User Prompt]\n${conversation[0].content}`);
    } else {
      const turns = conversation.map((msg) => {
        const speaker = msg.role === "user" ? (msg.name ? `User (${msg.name})` : "User") : "Assistant";
        return `${speaker}:\n${msg.content}`;
      });
      sections.push(`[Conversation History]\n${turns.join("\n\n")}`);
    }
  }

  return sections.join("\n\n");
}

import type {
  NormalizedConversationMessage,
  ResponseRecord,
} from "./response-registry.js";
import type {
  ResponseInputContentPart,
  ResponseInputItem,
  ResponseInputMessageItem,
  ResponseTextContentPart,
} from "./types.js";

export interface ReconstructedContext {
  promptText: string;
  newTranscript: NormalizedConversationMessage[];
}

/**
 * Extracts plain text from an input content representation.
 */
export function extractResponseTextContent(
  content: string | ResponseInputContentPart[],
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

/**
 * Parses and categorizes the current request's input and top-level instructions into
 * system instructions (system + developer + top-level instructions) and current conversation turns.
 */
export function parseCurrentRequestInput(
  input: string | ResponseInputItem[],
  instructions?: string | null | undefined,
): {
  systemInstructions: string[];
  conversationTurns: NormalizedConversationMessage[];
} {
  const systemInstructions: string[] = [];
  const conversationTurns: NormalizedConversationMessage[] = [];

  // 1. Add top-level instructions if present
  if (instructions && typeof instructions === "string" && instructions.trim().length > 0) {
    systemInstructions.push(instructions.trim());
  }

  // 2. Parse input
  if (typeof input === "string") {
    if (input.trim().length > 0) {
      conversationTurns.push({
        role: "user",
        content: input,
      });
    }
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        if (item.trim().length > 0) {
          conversationTurns.push({
            role: "user",
            content: item,
          });
        }
      } else if (typeof item === "object" && item !== null) {
        const text = extractResponseTextContent(item.content);
        if (item.role === "system" || item.role === "developer") {
          const trimmed = text.trim();
          if (trimmed.length > 0 && !systemInstructions.includes(trimmed)) {
            systemInstructions.push(trimmed);
          }
        } else if (item.role === "user" || item.role === "assistant") {
          conversationTurns.push({
            role: item.role,
            content: text,
            ...(item.name ? { name: item.name } : {}),
          });
        }
      }
    }
  }

  return { systemInstructions, conversationTurns };
}

/**
 * Reconstructs the conversation context for a Response turn.
 *
 * Invariants:
 * 1. If previousRecord is present, previous visible conversation transcript is prepended.
 * 2. Old instructions from previousRecord are NEVER carried over or replayed.
 * 3. Only current turn instructions are included in the prompt.
 * 4. Message order is strictly preserved.
 */
export function reconstructResponseContext(options: {
  input: string | ResponseInputItem[];
  instructions?: string | null | undefined;
  previousRecord?: ResponseRecord | undefined;
}): ReconstructedContext {
  const { input, instructions, previousRecord } = options;

  const { systemInstructions, conversationTurns } = parseCurrentRequestInput(
    input,
    instructions,
  );

  // Reconstruct full visible transcript
  const baseTranscript: NormalizedConversationMessage[] = previousRecord
    ? [...previousRecord.transcript]
    : [];

  const fullConversation: NormalizedConversationMessage[] = [
    ...baseTranscript,
    ...conversationTurns,
  ];

  // Serialize to AGY prompt
  // Case 1: Simple single user message with no previous transcript and no system instructions
  if (
    systemInstructions.length === 0 &&
    fullConversation.length === 1 &&
    fullConversation[0]?.role === "user"
  ) {
    return {
      promptText: fullConversation[0].content,
      newTranscript: fullConversation,
    };
  }

  const sections: string[] = [];

  // Add system instructions if present
  if (systemInstructions.length > 0) {
    sections.push(`[System Instructions]\n${systemInstructions.join("\n\n")}`);
  }

  // Add conversation history
  if (fullConversation.length > 0) {
    if (fullConversation.length === 1 && fullConversation[0]?.role === "user") {
      sections.push(`[User Prompt]\n${fullConversation[0].content}`);
    } else {
      const turns = fullConversation.map((msg) => {
        const speaker =
          msg.role === "user"
            ? msg.name
              ? `User (${msg.name})`
              : "User"
            : "Assistant";
        return `${speaker}:\n${msg.content}`;
      });
      sections.push(`[Conversation History]\n${turns.join("\n\n")}`);
    }
  }

  const promptText = sections.join("\n\n");

  return {
    promptText,
    newTranscript: fullConversation,
  };
}

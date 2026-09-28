import { OpenAIHttpError } from "./errors.js";
import type {
  ResponseCreateRequest,
  ResponseInputContentPart,
  ResponseInputItem,
  ResponseInputMessageItem,
  ResponseReasoningEffort,
  ResponseRole,
  ResponseTextContentPart,
} from "./types.js";

const VALID_ROLES = new Set<string>(["system", "developer", "user", "assistant"]);
const VALID_REASONING_EFFORTS = new Set<string>(["low", "medium", "high"]);

const KNOWN_UNSUPPORTED_TOP_LEVEL = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "background",
  "conversation",
  "prompt",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "temperature",
  "top_p",
  "top_logprobs",
  "max_output_tokens",
  "max_tokens",
  "max_completion_tokens",
  "truncation",
  "service_tier",
  "safety_identifier",
  "user",
  "stop",
  "logit_bias",
  "presence_penalty",
  "frequency_penalty",
  "n",
  "functions",
  "function_call",
  "cwd",
  "workspace",
  "geminiHome",
  "filesystem",
];

const KNOWN_SUPPORTED_FIELDS = new Set<string>([
  "model",
  "input",
  "instructions",
  "previous_response_id",
  "stream",
  "reasoning",
  "reasoning_effort",
  "store",
  "metadata",
]);

/**
 * Validates an incoming Responses API request against supported parameters.
 * Throws OpenAIHttpError(400) on any invalid or unsupported field.
 */
export function validateResponseCreateRequest(body: unknown): ResponseCreateRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OpenAIHttpError(400, "Request body must be a JSON object", {
      code: "invalid_payload",
      param: null,
    });
  }

  const raw = body as Record<string, unknown>;

  // 1. Check for unsupported or unknown parameters
  for (const key of Object.keys(raw)) {
    if (KNOWN_UNSUPPORTED_TOP_LEVEL.includes(key)) {
      throw new OpenAIHttpError(400, `The parameter '${key}' is not supported in this version.`, {
        code: "unsupported_parameter",
        param: key,
      });
    }
    if (!KNOWN_SUPPORTED_FIELDS.has(key)) {
      throw new OpenAIHttpError(400, `The parameter '${key}' is unrecognized or not supported.`, {
        code: "unsupported_parameter",
        param: key,
      });
    }
  }

  // 2. Validate 'model'
  if (typeof raw["model"] !== "string" || raw["model"].trim().length === 0) {
    throw new OpenAIHttpError(400, "Missing required parameter: 'model'.", {
      code: "missing_required_parameter",
      param: "model",
    });
  }
  const model = raw["model"].trim();

  // 3. Validate 'input'
  if (raw["input"] === undefined || raw["input"] === null) {
    throw new OpenAIHttpError(400, "Missing required parameter: 'input'.", {
      code: "missing_required_parameter",
      param: "input",
    });
  }

  let validatedInput: string | ResponseInputItem[];

  if (typeof raw["input"] === "string") {
    validatedInput = raw["input"];
  } else if (Array.isArray(raw["input"])) {
    if (raw["input"].length === 0) {
      throw new OpenAIHttpError(400, "'input' must be a non-empty string or array.", {
        code: "invalid_value",
        param: "input",
      });
    }

    const items: ResponseInputItem[] = [];
    for (let i = 0; i < raw["input"].length; i++) {
      const item = raw["input"][i];
      if (typeof item === "string") {
        items.push(item);
        continue;
      }

      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new OpenAIHttpError(400, `Input item at index ${i} must be a string or object.`, {
          code: "invalid_value",
          param: `input[${i}]`,
        });
      }

      const rawItem = item as Record<string, unknown>;

      // Check item type if present
      if (rawItem["type"] !== undefined) {
        if (rawItem["type"] !== "message") {
          throw new OpenAIHttpError(
            400,
            `Input item type '${String(rawItem["type"])}' is not supported in this version. Only 'message' items are supported.`,
            {
              code: "unsupported_item_type",
              param: `input[${i}].type`,
            },
          );
        }
      }

      // Check role
      const roleStr = typeof rawItem["role"] === "string" ? rawItem["role"] : undefined;
      if (!roleStr || !VALID_ROLES.has(roleStr)) {
        throw new OpenAIHttpError(
          400,
          `Input item at index ${i} has invalid role '${String(rawItem["role"])}'. Supported: system, developer, user, assistant.`,
          {
            code: "invalid_value",
            param: `input[${i}].role`,
          },
        );
      }
      const role = roleStr as ResponseRole;

      // Check content
      const content = rawItem["content"];
      if (typeof content === "string") {
        items.push({
          type: "message",
          role,
          content,
          ...(typeof rawItem["name"] === "string" ? { name: rawItem["name"] } : {}),
        });
      } else if (Array.isArray(content)) {
        if (content.length === 0) {
          throw new OpenAIHttpError(400, `Input message at index ${i} has empty content array.`, {
            code: "invalid_value",
            param: `input[${i}].content`,
          });
        }

        const parts: ResponseTextContentPart[] = [];
        for (let j = 0; j < content.length; j++) {
          const part = content[j];
          if (typeof part !== "object" || part === null || Array.isArray(part)) {
            throw new OpenAIHttpError(400, `Content part at input[${i}].content[${j}] must be an object.`, {
              code: "invalid_value",
              param: `input[${i}].content[${j}]`,
            });
          }
          const rawPart = part as Record<string, unknown>;
          const partType = rawPart["type"];
          if (partType !== "input_text" && partType !== "text") {
            throw new OpenAIHttpError(
              400,
              `Content type '${String(partType)}' is not supported in this version. Only text content is supported.`,
              {
                code: "unsupported_content_type",
                param: `input[${i}].content[${j}].type`,
              },
            );
          }
          if (typeof rawPart["text"] !== "string") {
            throw new OpenAIHttpError(400, `Content part at input[${i}].content[${j}] requires string 'text'.`, {
              code: "invalid_value",
              param: `input[${i}].content[${j}].text`,
            });
          }
          parts.push({
            type: partType as "input_text" | "text",
            text: rawPart["text"],
          });
        }

        items.push({
          type: "message",
          role,
          content: parts,
          ...(typeof rawItem["name"] === "string" ? { name: rawItem["name"] } : {}),
        });
      } else {
        throw new OpenAIHttpError(
          400,
          `Input message at index ${i} has invalid 'content'. Must be a string or array of text parts.`,
          {
            code: "invalid_value",
            param: `input[${i}].content`,
          },
        );
      }
    }
    validatedInput = items;
  } else {
    throw new OpenAIHttpError(400, "'input' must be a string or array.", {
      code: "invalid_value",
      param: "input",
    });
  }

  // 4. Validate 'instructions'
  let instructions: string | null | undefined;
  if (raw["instructions"] !== undefined && raw["instructions"] !== null) {
    if (typeof raw["instructions"] === "string") {
      instructions = raw["instructions"];
    } else if (Array.isArray(raw["instructions"])) {
      const parts: string[] = [];
      for (let k = 0; k < raw["instructions"].length; k++) {
        const p = raw["instructions"][k];
        if (typeof p === "string") {
          parts.push(p);
        } else if (typeof p === "object" && p !== null) {
          const rawP = p as Record<string, unknown>;
          if (typeof rawP["text"] === "string") {
            parts.push(rawP["text"]);
          } else {
            throw new OpenAIHttpError(400, `instructions[${k}] text part must have string 'text'.`, {
              code: "invalid_value",
              param: `instructions[${k}]`,
            });
          }
        }
      }
      instructions = parts.join("\n\n");
    } else {
      throw new OpenAIHttpError(400, "'instructions' must be a string or array of text parts.", {
        code: "invalid_value",
        param: "instructions",
      });
    }
  }

  // 5. Validate 'previous_response_id'
  let previousResponseId: string | null | undefined;
  if (raw["previous_response_id"] !== undefined && raw["previous_response_id"] !== null) {
    if (typeof raw["previous_response_id"] !== "string" || raw["previous_response_id"].trim().length === 0) {
      throw new OpenAIHttpError(400, "'previous_response_id' must be a non-empty string.", {
        code: "invalid_value",
        param: "previous_response_id",
      });
    }
    previousResponseId = raw["previous_response_id"].trim();
  }

  // 6. Validate 'stream'
  let stream = false;
  if (raw["stream"] !== undefined) {
    if (typeof raw["stream"] !== "boolean") {
      throw new OpenAIHttpError(400, "'stream' must be a boolean.", {
        code: "invalid_value",
        param: "stream",
      });
    }
    stream = raw["stream"];
  }

  // 7. Validate 'reasoning' and 'reasoning_effort'
  let reasoningEffort: ResponseReasoningEffort | undefined;
  if (raw["reasoning"] !== undefined && raw["reasoning"] !== null) {
    if (typeof raw["reasoning"] !== "object" || Array.isArray(raw["reasoning"])) {
      throw new OpenAIHttpError(400, "'reasoning' must be an object.", {
        code: "invalid_value",
        param: "reasoning",
      });
    }
    const rawReasoning = raw["reasoning"] as Record<string, unknown>;
    if (rawReasoning["effort"] !== undefined) {
      if (typeof rawReasoning["effort"] !== "string" || !VALID_REASONING_EFFORTS.has(rawReasoning["effort"])) {
        throw new OpenAIHttpError(400, "'reasoning.effort' must be one of 'low', 'medium', 'high'.", {
          code: "unsupported_value",
          param: "reasoning.effort",
        });
      }
      reasoningEffort = rawReasoning["effort"] as ResponseReasoningEffort;
    }
  }

  if (raw["reasoning_effort"] !== undefined) {
    if (typeof raw["reasoning_effort"] !== "string" || !VALID_REASONING_EFFORTS.has(raw["reasoning_effort"])) {
      throw new OpenAIHttpError(400, "'reasoning_effort' must be one of 'low', 'medium', 'high'.", {
        code: "unsupported_value",
        param: "reasoning_effort",
      });
    }
    reasoningEffort = raw["reasoning_effort"] as ResponseReasoningEffort;
  }

  // 8. Validate 'store'
  let store = true;
  if (raw["store"] !== undefined) {
    if (typeof raw["store"] !== "boolean") {
      throw new OpenAIHttpError(400, "'store' must be a boolean.", {
        code: "invalid_value",
        param: "store",
      });
    }
    store = raw["store"];
  }

  // 9. Validate 'metadata'
  let metadata: Record<string, string> | null | undefined;
  if (raw["metadata"] !== undefined && raw["metadata"] !== null) {
    if (typeof raw["metadata"] !== "object" || Array.isArray(raw["metadata"])) {
      throw new OpenAIHttpError(400, "'metadata' must be a key-value object.", {
        code: "invalid_value",
        param: "metadata",
      });
    }
    const rawMeta = raw["metadata"] as Record<string, unknown>;
    const keys = Object.keys(rawMeta);
    if (keys.length > 16) {
      throw new OpenAIHttpError(400, "Maximum of 16 key-value pairs allowed in 'metadata'.", {
        code: "invalid_value",
        param: "metadata",
      });
    }
    const validatedMeta: Record<string, string> = {};
    for (const k of keys) {
      if (k.length > 64) {
        throw new OpenAIHttpError(400, `Metadata key '${k}' exceeds maximum length of 64 characters.`, {
          code: "invalid_value",
          param: `metadata.${k}`,
        });
      }
      const val = rawMeta[k];
      if (typeof val !== "string") {
        throw new OpenAIHttpError(400, `Metadata value for key '${k}' must be a string.`, {
          code: "invalid_value",
          param: `metadata.${k}`,
        });
      }
      if (val.length > 512) {
        throw new OpenAIHttpError(400, `Metadata value for key '${k}' exceeds maximum length of 512 characters.`, {
          code: "invalid_value",
          param: `metadata.${k}`,
        });
      }
      validatedMeta[k] = val;
    }
    metadata = validatedMeta;
  }

  return {
    model,
    input: validatedInput,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(previousResponseId !== undefined ? { previous_response_id: previousResponseId } : {}),
    stream,
    ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort }, reasoning_effort: reasoningEffort } : {}),
    store,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

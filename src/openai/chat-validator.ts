import { OpenAIHttpError } from "./errors.js";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageInput,
  ChatCompletionRequest,
  ChatCompletionRole,
} from "./types.js";

const VALID_ROLES = new Set<string>(["system", "developer", "user", "assistant"]);
const VALID_REASONING_EFFORTS = new Set<string>(["low", "medium", "high"]);

const KNOWN_UNSUPPORTED_TOP_LEVEL = [
  "temperature",
  "top_p",
  "n",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "parallel_tool_calls",
  "response_format",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "user",
  "cwd",
  "workspace",
  "geminiHome",
  "filesystem",
];

const KNOWN_SUPPORTED_FIELDS = new Set<string>([
  "model",
  "messages",
  "stream",
  "reasoning_effort",
  "stream_options",
]);

/**
 * Validates an incoming Chat Completion request against supported OpenAI parameters.
 * Throws OpenAIHttpError(400) on any invalid or unsupported field.
 */
export function validateChatCompletionRequest(body: unknown): ChatCompletionRequest {
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

  // 3. Validate 'messages'
  if (!Array.isArray(raw["messages"]) || raw["messages"].length === 0) {
    throw new OpenAIHttpError(400, "'messages' must be a non-empty array.", {
      code: "invalid_value",
      param: "messages",
    });
  }

  const validatedMessages: ChatCompletionMessageInput[] = [];

  for (let i = 0; i < raw["messages"].length; i++) {
    const msg = raw["messages"][i];
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      throw new OpenAIHttpError(400, `Message at index ${i} must be an object.`, {
        code: "invalid_value",
        param: `messages[${i}]`,
      });
    }

    const rawMsg = msg as Record<string, unknown>;

    // Role check
    if (typeof rawMsg["role"] !== "string" || !VALID_ROLES.has(rawMsg["role"])) {
      throw new OpenAIHttpError(
        400,
        `Message at index ${i} has invalid role '${String(rawMsg["role"])}'. Supported: system, developer, user, assistant.`,
        {
          code: "invalid_value",
          param: `messages[${i}].role`,
        },
      );
    }
    const role = rawMsg["role"] as ChatCompletionRole;

    // Content check
    const content = rawMsg["content"];
    if (typeof content === "string") {
      validatedMessages.push({
        role,
        content,
        ...(typeof rawMsg["name"] === "string" ? { name: rawMsg["name"] } : {}),
      });
    } else if (Array.isArray(content)) {
      if (content.length === 0) {
        throw new OpenAIHttpError(400, `Message at index ${i} has empty content array.`, {
          code: "invalid_value",
          param: `messages[${i}].content`,
        });
      }

      for (let j = 0; j < content.length; j++) {
        const part = content[j];
        if (typeof part !== "object" || part === null || Array.isArray(part)) {
          throw new OpenAIHttpError(400, `Content part at messages[${i}].content[${j}] must be an object.`, {
            code: "invalid_value",
            param: `messages[${i}].content[${j}]`,
          });
        }
        const rawPart = part as Record<string, unknown>;
        if (rawPart["type"] !== "text" || typeof rawPart["text"] !== "string") {
          throw new OpenAIHttpError(
            400,
            `Content type '${String(rawPart["type"])}' is not supported. Only text content is supported.`,
            {
              code: "invalid_value",
              param: `messages[${i}].content[${j}]`,
            },
          );
        }
      }

      validatedMessages.push({
        role,
        content: content as ChatCompletionContentPart[],
        ...(typeof rawMsg["name"] === "string" ? { name: rawMsg["name"] } : {}),
      });
    } else {
      throw new OpenAIHttpError(
        400,
        `Message at index ${i} has invalid 'content'. Must be a string or an array of text parts.`,
        {
          code: "invalid_value",
          param: `messages[${i}].content`,
        },
      );
    }
  }

  // 4. Validate 'stream'
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

  // 5. Validate 'reasoning_effort'
  let reasoningEffort: "low" | "medium" | "high" | undefined;
  if (raw["reasoning_effort"] !== undefined) {
    if (typeof raw["reasoning_effort"] !== "string" || !VALID_REASONING_EFFORTS.has(raw["reasoning_effort"])) {
      throw new OpenAIHttpError(400, "'reasoning_effort' must be one of 'low', 'medium', 'high'.", {
        code: "invalid_value",
        param: "reasoning_effort",
      });
    }
    reasoningEffort = raw["reasoning_effort"] as "low" | "medium" | "high";
  }

  // 6. Validate 'stream_options'
  let streamOptions: { include_usage?: boolean } | undefined;
  if (raw["stream_options"] !== undefined) {
    if (typeof raw["stream_options"] !== "object" || raw["stream_options"] === null || Array.isArray(raw["stream_options"])) {
      throw new OpenAIHttpError(400, "'stream_options' must be a JSON object.", {
        code: "invalid_value",
        param: "stream_options",
      });
    }
    const rawStreamOptions = raw["stream_options"] as Record<string, unknown>;
    for (const optKey of Object.keys(rawStreamOptions)) {
      if (optKey !== "include_usage") {
        throw new OpenAIHttpError(400, `The stream option '${optKey}' is not supported.`, {
          code: "unsupported_parameter",
          param: `stream_options.${optKey}`,
        });
      }
    }
    if (rawStreamOptions["include_usage"] !== undefined && typeof rawStreamOptions["include_usage"] !== "boolean") {
      throw new OpenAIHttpError(400, "'stream_options.include_usage' must be a boolean.", {
        code: "invalid_value",
        param: "stream_options.include_usage",
      });
    }
    streamOptions = {
      ...(rawStreamOptions["include_usage"] !== undefined ? { include_usage: rawStreamOptions["include_usage"] as boolean } : {}),
    };
  }

  return {
    model,
    messages: validatedMessages,
    stream,
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    ...(streamOptions !== undefined ? { stream_options: streamOptions } : {}),
  };
}

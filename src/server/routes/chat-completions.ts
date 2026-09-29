import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PromptUsage } from "../../acp/runtime-types.js";
import { classifyProfileFailure } from "../../profiles/failure-classifier.js";
import { NoAvailableProfileError } from "../../profiles/profile-manager.js";
import type { ProfileRuntime } from "../../profiles/profile-runtime.js";
import { validateChatCompletionRequest } from "../../openai/chat-validator.js";
import {
  OpenAIHttpError,
  invalidApiKeyError,
  methodNotAllowedError,
  modelNotFoundError,
  serviceUnavailableError,
} from "../../openai/errors.js";
import { serializeConversation } from "../../openai/message-converter.js";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionUsage,
} from "../../openai/types.js";
import { verifyBearerAuth } from "../auth.js";
import {
  type RequestContext,
  initSseStream,
  readJsonBody,
  sendError,
  sendJson,
  writeSseChunk,
} from "../request-context.js";

export async function handleChatCompletions(
  context: RequestContext,
  abortController: AbortController,
): Promise<void> {
  const { req, res, requestId, config, modelCatalog, profileManager, logger } = context;

  // 1. Method check: only POST is allowed
  if (req.method !== "POST") {
    sendError(
      res,
      methodNotAllowedError(req.method ?? "UNKNOWN", "/v1/chat/completions", ["POST"]),
      requestId,
      { Allow: "POST" },
    );
    return;
  }

  // 2. Bearer Authentication check
  const authHeader = req.headers["authorization"];
  const isAuthorized = verifyBearerAuth(authHeader, config.apiKey);
  if (!isAuthorized) {
    sendError(res, invalidApiKeyError(), requestId);
    return;
  }

  // 3. Read and validate JSON body
  const rawBody = await readJsonBody(req, config.bodyLimitBytes);
  const validatedRequest = validateChatCompletionRequest(rawBody);

  const { model, messages, stream, reasoning_effort, stream_options } = validatedRequest;

  // 4. Model-aware profile routing validation
  const modelObj = await modelCatalog.getModel(model);
  if (!modelObj) {
    sendError(res, modelNotFoundError(model), requestId);
    return;
  }

  const eligibleProfiles = modelCatalog.getProfilesForModel(model);
  if (eligibleProfiles.length === 0) {
    sendError(
      res,
      serviceUnavailableError(`No Antigravity profile supporting model '${model}' is currently registered.`),
      requestId,
    );
    return;
  }

  // 5. Serialize prompt
  const promptText = serializeConversation(messages);
  const chatCompletionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);

  // Link client disconnect to controller
  res.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  if (stream) {
    await handleStreamingCompletion({
      context,
      abortController,
      chatCompletionId,
      created,
      model,
      promptText,
      reasoningEffort: reasoning_effort,
      includeUsage: stream_options?.include_usage ?? false,
      eligibleProfiles,
    });
  } else {
    await handleNonStreamingCompletion({
      context,
      abortController,
      chatCompletionId,
      created,
      model,
      promptText,
      reasoningEffort: reasoning_effort,
      eligibleProfiles,
    });
  }
}

interface NonStreamingOptions {
  context: RequestContext;
  abortController: AbortController;
  chatCompletionId: string;
  created: number;
  model: string;
  promptText: string;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  eligibleProfiles: string[];
}

async function handleNonStreamingCompletion(options: NonStreamingOptions): Promise<void> {
  const { context, abortController, chatCompletionId, created, model, promptText, reasoningEffort, eligibleProfiles } = options;
  const { res, requestId, profileManager, logger } = context;

  let failoverCount = 0;

  try {
    const outcome = await profileManager.withFailover(
      async (profile, attempt) => {
        if (attempt > 1) {
          failoverCount++;
        }
        return executeTurnOnProfile({
          profile,
          model,
          promptText,
          reasoningEffort,
          signal: abortController.signal,
          logger,
        });
      },
      {
        eligibleProfileIds: eligibleProfiles,
      },
    );

    const finishReason = outcome.stopReason === "end_turn" ? "stop" : outcome.stopReason;
    const responsePayload: ChatCompletionResponse = {
      id: chatCompletionId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: outcome.assistantContent,
          },
          finish_reason: finishReason,
        },
      ],
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    };

    logger.info("Chat completion non-streaming completed", {
      requestId,
      chatCompletionId,
      profileId: outcome.profileId,
      requestedModel: model,
      stream: false,
      failoverCount,
      stopReason: finishReason,
      ...(outcome.usage !== undefined
        ? {
            promptTokens: outcome.usage.prompt_tokens,
            completionTokens: outcome.usage.completion_tokens,
            totalTokens: outcome.usage.total_tokens,
          }
        : {}),
    });

    if (failoverCount > 0) {
      context.metrics.recordFailover(failoverCount);
    }
    if (outcome.usage) {
      context.metrics.recordTokens(outcome.usage.prompt_tokens, outcome.usage.completion_tokens);
    }

    sendJson(res, 200, responsePayload, requestId);
  } catch (error) {
    if (error instanceof NoAvailableProfileError) {
      sendError(res, serviceUnavailableError("No Antigravity profile is currently available to serve this model."), requestId);
      return;
    }
    sendError(res, error, requestId);
  }
}

interface StreamingOptions {
  context: RequestContext;
  abortController: AbortController;
  chatCompletionId: string;
  created: number;
  model: string;
  promptText: string;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  includeUsage: boolean;
  eligibleProfiles: string[];
}

async function handleStreamingCompletion(options: StreamingOptions): Promise<void> {
  const { context, abortController, chatCompletionId, created, model, promptText, reasoningEffort, includeUsage, eligibleProfiles } = options;
  const { res, requestId, profileManager, logger } = context;

  context.metrics.recordStreamStart();
  try {
    const attemptedProfiles = new Set<string>();
    let streamCommitted = false;
    let lastError: unknown;
    let activeProfileId: string | undefined;

  for (let attempt = 1; attempt <= eligibleProfiles.length; attempt++) {
    // If output has already been committed to the client, failover is strictly forbidden
    if (streamCommitted) {
      break;
    }

    let lease;
    try {
      lease = profileManager.acquire({
        eligibleProfileIds: eligibleProfiles,
        excludeProfileIds: attemptedProfiles,
      });
    } catch (acquireErr) {
      if (acquireErr instanceof NoAvailableProfileError && lastError) {
        throw lastError;
      }
      throw acquireErr;
    }

    const currentProfile = lease.profile;
    activeProfileId = currentProfile.id;
    attemptedProfiles.add(currentProfile.id);

    let scratchDir: string | undefined;
    let sessionId: string | undefined;

    try {
      // 1. Session setup
      scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "refined-agy-stream-"));
      const session = await currentProfile.runtime.newSession({ cwd: scratchDir });
      sessionId = session.sessionId;

      const targetMode = currentProfile.config.sessionMode ?? "yolo";
      const availableModes = session.modes?.availableModes.map((m) => m.id) ?? [];
      if (availableModes.includes(targetMode) && session.modes?.currentModeId !== targetMode) {
        await currentProfile.runtime.setMode(session.sessionId, targetMode);
      }

      const modelOption = session.configOptions?.find((o) => o.id === "model" || o.category === "model");
      if (modelOption) {
        const supported = modelOption.options?.map((opt) => String(opt.value)) ?? [];
        if (supported.length > 0 && !supported.includes(model)) {
          throw serviceUnavailableError(`Model '${model}' is temporarily unavailable on profile '${currentProfile.id}'`);
        }
        if (modelOption.currentValue !== model) {
          await currentProfile.runtime.setConfigOption(session.sessionId, modelOption.id, model);
        }
      }

      const targetThought = reasoningEffort ?? "low";
      const thoughtOption = session.configOptions?.find((o) => o.id === "thought_level" || o.category === "thought_level");
      if (thoughtOption) {
        const supported = thoughtOption.options?.map((opt) => String(opt.value)) ?? [];
        if (supported.includes(targetThought) && thoughtOption.currentValue !== targetThought) {
          await currentProfile.runtime.setConfigOption(session.sessionId, thoughtOption.id, targetThought);
        }
      }

      // 2. Dispatch prompt
      const turn = currentProfile.runtime.prompt(session.sessionId, promptText, {
        signal: abortController.signal,
      });

      // 3. Process incoming stream events
      for await (const update of turn.updates) {
        if (update.sessionUpdate === "agent_message_chunk") {
          const chunkText = extractChunkText(update.update);
          if (chunkText.length > 0) {
            // First content chunk commits the stream to the client
            if (!streamCommitted) {
              initSseStream(res, requestId);
              // Send initial role chunk
              const initialChunk: ChatCompletionChunk = {
                id: chatCompletionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant" },
                    finish_reason: null,
                  },
                ],
              };
              await writeSseChunk(res, `data: ${JSON.stringify(initialChunk)}\n\n`, abortController.signal);
              streamCommitted = true;
            }

            // Send content delta chunk
            const contentChunk: ChatCompletionChunk = {
              id: chatCompletionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: chunkText },
                  finish_reason: null,
                },
              ],
            };
            await writeSseChunk(res, `data: ${JSON.stringify(contentChunk)}\n\n`, abortController.signal);
          }
        }
        // Note: agent_thought_chunk, tool_call, tool_call_update are filtered out
      }

      const promptResult = await turn.result;
      const finishReason = promptResult.stopReason === "end_turn" ? "stop" : promptResult.stopReason;

      // If no content chunk was emitted at all, turn failed or quota was exhausted before any output
      if (!streamCommitted) {
        throw new Error(
          `Streaming model execution returned no content chunks (stopReason: ${promptResult.stopReason}); possible quota exhausted or upstream error`,
        );
      }

      // Send final stop chunk
      const finalChunk: ChatCompletionChunk = {
        id: chatCompletionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      };
      await writeSseChunk(res, `data: ${JSON.stringify(finalChunk)}\n\n`, abortController.signal);

      // Send usage chunk if stream_options.include_usage was requested and usage is available
      if (includeUsage && promptResult.usage) {
        const usage = mapToOpenAiUsage(promptResult.usage);
        if (usage) {
          const usageChunk: ChatCompletionChunk = {
            id: chatCompletionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage,
          };
          await writeSseChunk(res, `data: ${JSON.stringify(usageChunk)}\n\n`, abortController.signal);
        }
      }

      await writeSseChunk(res, "data: [DONE]\n\n", abortController.signal);
      res.end();

      currentProfile.markSuccess();

      logger.info("Chat completion streaming completed", {
        requestId,
        chatCompletionId,
        profileId: currentProfile.id,
        requestedModel: model,
        stream: true,
        stopReason: finishReason,
        ...(promptResult.usage?.inputTokens !== undefined
          ? {
              promptTokens: promptResult.usage.inputTokens,
              completionTokens: promptResult.usage.outputTokens,
              totalTokens: promptResult.usage.totalTokens,
            }
          : {}),
      });

      if (attempt > 1) {
        context.metrics.recordFailover(attempt - 1);
      }
      if (promptResult.usage?.inputTokens !== undefined) {
        context.metrics.recordTokens(promptResult.usage.inputTokens, promptResult.usage.outputTokens);
      }

      return; // Stream finished successfully
    } catch (turnError) {
      lastError = turnError;
      const classification = classifyProfileFailure(turnError);
      currentProfile.markFailure(classification.kind, turnError, classification.cooldownMs);

      logger.warn("Streaming turn encountered error", {
        requestId,
        profileId: currentProfile.id,
        streamCommitted,
        classification: classification.kind,
        error: turnError instanceof Error ? turnError.message : String(turnError),
      });

      // If output was already committed to client, abort turn and terminate SSE cleanly without replay
      if (streamCommitted) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      // If output was not committed and error is not retryable, rethrow immediately
      if (!classification.retryableOnAnotherProfile) {
        throw turnError;
      }
    } finally {
      if (sessionId) currentProfile.runtime.forgetSession(sessionId);
      lease.release();
      if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // If we reach here, all attempts failed before output commit
  if (!streamCommitted) {
    if (lastError instanceof NoAvailableProfileError) {
      sendError(res, serviceUnavailableError("No Antigravity profile is currently available to serve this model."), requestId);
      return;
    }
    sendError(res, lastError, requestId);
  }
} finally {
  context.metrics.recordStreamEnd();
}
}

interface TurnExecutionResult {
  assistantContent: string;
  stopReason: string;
  usage?: ChatCompletionUsage | undefined;
  profileId: string;
}

async function executeTurnOnProfile(options: {
  profile: ProfileRuntime;
  model: string;
  promptText: string;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  signal: AbortSignal;
  logger: RequestContext["logger"];
}): Promise<TurnExecutionResult> {
  const { profile, model, promptText, reasoningEffort, signal } = options;
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "refined-agy-turn-"));
  let sessionId: string | undefined;

  try {
    const session = await profile.runtime.newSession({ cwd: scratchDir });
    sessionId = session.sessionId;

    const targetMode = profile.config.sessionMode ?? "yolo";
    const availableModes = session.modes?.availableModes.map((m) => m.id) ?? [];
    if (availableModes.includes(targetMode) && session.modes?.currentModeId !== targetMode) {
      await profile.runtime.setMode(session.sessionId, targetMode);
    }

    const modelOption = session.configOptions?.find((o) => o.id === "model" || o.category === "model");
    if (modelOption) {
      const supported = modelOption.options?.map((opt) => String(opt.value)) ?? [];
      if (supported.length > 0 && !supported.includes(model)) {
        throw serviceUnavailableError(`Model '${model}' is temporarily unavailable on profile '${profile.id}'`);
      }
      if (modelOption.currentValue !== model) {
        await profile.runtime.setConfigOption(session.sessionId, modelOption.id, model);
      }
    }

    const targetThought = reasoningEffort ?? "low";
    const thoughtOption = session.configOptions?.find((o) => o.id === "thought_level" || o.category === "thought_level");
    if (thoughtOption) {
      const supported = thoughtOption.options?.map((opt) => String(opt.value)) ?? [];
      if (supported.includes(targetThought) && thoughtOption.currentValue !== targetThought) {
        await profile.runtime.setConfigOption(session.sessionId, thoughtOption.id, targetThought);
      }
    }

    const turn = profile.runtime.prompt(session.sessionId, promptText, { signal });

    let assistantContent = "";
    for await (const update of turn.updates) {
      if (update.sessionUpdate === "agent_message_chunk") {
        const text = extractChunkText(update.update);
        assistantContent += text;
      }
    }

    const promptResult = await turn.result;
    if (assistantContent.trim() === "") {
      throw new Error(
        `Model execution returned empty content (stopReason: ${promptResult.stopReason}); possible quota exhausted or upstream error`,
      );
    }
    const lowerContent = assistantContent.toLowerCase();
    if (lowerContent.includes("usage limit reached") || lowerContent.includes("reached your current quota")) {
      throw new Error(`Profile ${profile.id} quota exhausted: ${assistantContent.trim()}`);
    }
    const usage = mapToOpenAiUsage(promptResult.usage);

    return {
      assistantContent,
      stopReason: promptResult.stopReason,
      ...(usage !== undefined ? { usage } : {}),
      profileId: profile.id,
    };
  } finally {
    if (sessionId) profile.runtime.forgetSession(sessionId);
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

function mapToOpenAiUsage(promptUsage?: PromptUsage): ChatCompletionUsage | undefined {
  if (!promptUsage) return undefined;

  const promptTokens = promptUsage.inputTokens;
  const completionTokens = promptUsage.outputTokens;
  let totalTokens = promptUsage.totalTokens;

  // If no token metrics were reported, do not manufacture zeroes
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  const p = promptTokens ?? 0;
  const c = completionTokens ?? 0;
  const t = totalTokens ?? (p + c);

  return {
    prompt_tokens: p,
    completion_tokens: c,
    total_tokens: t,
  };
}

function extractChunkText(payload: Record<string, unknown>): string {
  const content = payload["content"];
  if (typeof content === "object" && content !== null && "text" in content && typeof content["text"] === "string") {
    return content["text"];
  }
  if (typeof payload["text"] === "string") {
    return payload["text"];
  }
  return "";
}

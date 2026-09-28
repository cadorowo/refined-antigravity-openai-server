import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PromptUsage } from "../../acp/runtime-types.js";
import { classifyProfileFailure } from "../../profiles/failure-classifier.js";
import { NoAvailableProfileError } from "../../profiles/profile-manager.js";
import type { ProfileRuntime } from "../../profiles/profile-runtime.js";
import {
  OpenAIHttpError,
  invalidApiKeyError,
  methodNotAllowedError,
  modelNotFoundError,
  responseNotFoundError,
  serviceUnavailableError,
} from "../../openai/errors.js";
import { reconstructResponseContext } from "../../openai/response-converter.js";
import type {
  NormalizedConversationMessage,
  ResponseRecord,
} from "../../openai/response-registry.js";
import { validateResponseCreateRequest } from "../../openai/response-validator.js";

import type {
  ResponseCreateRequest,
  ResponseObject,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningEffort,
  ResponseStreamServerEvent,
  ResponseUsage,
} from "../../openai/types.js";
import { verifyBearerAuth } from "../auth.js";
import {
  type RequestContext,
  initSseStream,
  readJsonBody,
  sendError,
  sendJson,
} from "../request-context.js";

export async function handleResponses(
  context: RequestContext,
  abortController: AbortController,
): Promise<void> {
  const { req, res, requestId, config, modelCatalog, responseRegistry, logger } = context;

  // 1. Method check: only POST is allowed on /v1/responses
  if (req.method !== "POST") {
    sendError(
      res,
      methodNotAllowedError(req.method ?? "UNKNOWN", "/v1/responses", ["POST"]),
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
  const validatedRequest = validateResponseCreateRequest(rawBody);

  const {
    model,
    input,
    instructions,
    previous_response_id,
    stream,
    reasoning,
    reasoning_effort,
    store,
    metadata,
  } = validatedRequest;

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

  // 5. Continuation lookup via previous_response_id
  let previousRecord: ResponseRecord | undefined;
  let workspace: string;
  let preferredProfileId: string | undefined;
  let isNewChain = false;

  if (previous_response_id) {
    previousRecord = responseRegistry.get(previous_response_id);
    if (!previousRecord) {
      sendError(res, responseNotFoundError(previous_response_id), requestId);
      return;
    }

    if (previousRecord.status !== "completed") {
      sendError(
        res,
        new OpenAIHttpError(
          400,
          `Cannot continue from response '${previous_response_id}' because its status is '${previousRecord.status}'. Only completed responses can be continued.`,
          {
            code: "invalid_previous_response_status",
            param: "previous_response_id",
          },
        ),
        requestId,
      );
      return;
    }

    workspace = previousRecord.workspace;
    await fs.mkdir(workspace, { recursive: true }).catch(() => {});
    preferredProfileId = previousRecord.preferredProfileId;
  } else {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "refined-agy-chain-"));
    isNewChain = true;
  }

  // 6. Context reconstruction
  const { promptText, newTranscript } = reconstructResponseContext({
    input,
    instructions,
    previousRecord,
  });

  const responseId = `resp_${crypto.randomBytes(16).toString("hex")}`;
  const messageId = `msg_${crypto.randomBytes(16).toString("hex")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const reasoningEffortValue = reasoning?.effort ?? reasoning_effort;

  // Link client disconnect to controller
  res.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  if (stream) {
    await handleStreamingResponse({
      context,
      abortController,
      responseId,
      messageId,
      createdAt,
      model,
      promptText,
      newTranscript,
      workspace,
      isNewChain,
      instructions: instructions ?? null,
      previousResponseId: previous_response_id ?? null,
      reasoningEffort: reasoningEffortValue,
      store: store ?? true,
      metadata: metadata ?? null,
      preferredProfileId,
      eligibleProfiles,
    });
  } else {
    await handleNonStreamingResponse({
      context,
      abortController,
      responseId,
      messageId,
      createdAt,
      model,
      promptText,
      newTranscript,
      workspace,
      isNewChain,
      instructions: instructions ?? null,
      previousResponseId: previous_response_id ?? null,
      reasoningEffort: reasoningEffortValue,
      store: store ?? true,
      metadata: metadata ?? null,
      preferredProfileId,
      eligibleProfiles,
    });
  }
}

export async function handleGetResponse(
  context: RequestContext,
  responseId: string,
): Promise<void> {
  const { req, res, requestId, config, responseRegistry } = context;

  // 1. Method check: only GET is allowed
  if (req.method !== "GET") {
    sendError(
      res,
      methodNotAllowedError(req.method ?? "UNKNOWN", `/v1/responses/${responseId}`, ["GET"]),
      requestId,
      { Allow: "GET" },
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

  // 3. Lookup in registry
  const record = responseRegistry.get(responseId);
  if (!record) {
    sendError(res, responseNotFoundError(responseId), requestId);
    return;
  }

  const responsePayload = responseRegistry.toResponseObject(record);
  sendJson(res, 200, responsePayload, requestId);
}

interface NonStreamingResponseOptions {
  context: RequestContext;
  abortController: AbortController;
  responseId: string;
  messageId: string;
  createdAt: number;
  model: string;
  promptText: string;
  newTranscript: NormalizedConversationMessage[];
  workspace: string;

  isNewChain: boolean;
  instructions: string | null;
  previousResponseId: string | null;
  reasoningEffort?: ResponseReasoningEffort | undefined;
  store: boolean;
  metadata: Record<string, string> | null;
  preferredProfileId?: string | undefined;
  eligibleProfiles: string[];
}

async function handleNonStreamingResponse(options: NonStreamingResponseOptions): Promise<void> {
  const {
    context,
    abortController,
    responseId,
    messageId,
    createdAt,
    model,
    promptText,
    newTranscript,
    workspace,
    isNewChain,
    instructions,
    previousResponseId,
    reasoningEffort,
    store,
    metadata,
    preferredProfileId,
    eligibleProfiles,
  } = options;
  const { res, requestId, profileManager, responseRegistry, logger } = context;

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
          workspace,
          reasoningEffort,
          signal: abortController.signal,
          logger,
        });
      },
      {
        eligibleProfileIds: eligibleProfiles,
        preferredProfileId,
      },
    );

    const completedAt = Math.floor(Date.now() / 1000);
    const outputItem: ResponseOutputMessage = {
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: outcome.assistantContent,
          annotations: [],
        },
      ],
    };

    const responsePayload: ResponseObject = {
      id: responseId,
      object: "response",
      created_at: createdAt,
      completed_at: completedAt,
      status: "completed",
      model,
      output: [outputItem],
      output_text: outcome.assistantContent,
      error: null,
      incomplete_details: null,
      instructions,
      metadata,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      previous_response_id: previousResponseId,
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    };

    // Store in ResponseRegistry if requested
    if (store) {
      responseRegistry.save({
        id: responseId,
        createdAt,
        completedAt,
        lastAccessedAt: Date.now(),
        model,
        previousResponseId,
        preferredProfileId: outcome.profileId,
        workspace,
        transcript: newTranscript,
        outputText: outcome.assistantContent,
        usage: outcome.usage,
        status: "completed",
        instructions,
        metadata,
        store: true,
      });
    } else if (isNewChain) {
      // Clean up ephemeral workspace if store is false and chain won't be continued
      fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }

    logger.info("Response non-streaming completed", {
      requestId,
      responseId,
      previousResponseId,
      profileId: outcome.profileId,
      requestedModel: model,
      stream: false,
      failoverCount,
      stopReason: outcome.stopReason,
      ...(outcome.usage !== undefined
        ? {
            inputTokens: outcome.usage.input_tokens,
            outputTokens: outcome.usage.output_tokens,
            totalTokens: outcome.usage.total_tokens,
          }
        : {}),
    });

    if (failoverCount > 0) {
      context.metrics.recordFailover(failoverCount);
    }
    if (outcome.usage) {
      context.metrics.recordTokens(outcome.usage.input_tokens, outcome.usage.output_tokens);
    }

    sendJson(res, 200, responsePayload, requestId);
  } catch (error) {
    if (isNewChain && !store) {
      fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
    if (error instanceof NoAvailableProfileError) {
      sendError(
        res,
        serviceUnavailableError("No Antigravity profile is currently available to serve this model."),
        requestId,
      );
      return;
    }
    sendError(res, error, requestId);
  }
}

interface StreamingResponseOptions {
  context: RequestContext;
  abortController: AbortController;
  responseId: string;
  messageId: string;
  createdAt: number;
  model: string;
  promptText: string;
  newTranscript: NormalizedConversationMessage[];
  workspace: string;

  isNewChain: boolean;
  instructions: string | null;
  previousResponseId: string | null;
  reasoningEffort?: ResponseReasoningEffort | undefined;
  store: boolean;
  metadata: Record<string, string> | null;
  preferredProfileId?: string | undefined;
  eligibleProfiles: string[];
}

async function handleStreamingResponse(options: StreamingResponseOptions): Promise<void> {
  const {
    context,
    abortController,
    responseId,
    messageId,
    createdAt,
    model,
    promptText,
    newTranscript,
    workspace,
    isNewChain,
    instructions,
    previousResponseId,
    reasoningEffort,
    store,
    metadata,
    preferredProfileId,
    eligibleProfiles,
  } = options;
  const { res, requestId, profileManager, responseRegistry, logger } = context;

  context.metrics.recordStreamStart();
  try {
    const attemptedProfiles = new Set<string>();
    let streamCommitted = false;
  let lastError: unknown;
  let sequenceNumber = 0;

  for (let attempt = 1; attempt <= eligibleProfiles.length; attempt++) {
    // If output has already been committed to the client, failover is strictly forbidden
    if (streamCommitted) {
      break;
    }

    let lease;
    try {
      lease = profileManager.acquire({
        eligibleProfileIds: eligibleProfiles,
        preferredProfileId,
        excludeProfileIds: attemptedProfiles,
      });
    } catch (acquireErr) {
      if (acquireErr instanceof NoAvailableProfileError && lastError) {
        throw lastError;
      }
      throw acquireErr;
    }

    const currentProfile = lease.profile;
    attemptedProfiles.add(currentProfile.id);

    try {
      // 1. Session setup
      const session = await currentProfile.runtime.newSession({ cwd: workspace });

      const targetMode = currentProfile.config.sessionMode ?? "yolo";
      const availableModes = session.modes?.availableModes.map((m) => m.id) ?? [];
      if (availableModes.includes(targetMode)) {
        await currentProfile.runtime.setMode(session.sessionId, targetMode);
      }

      const modelOption = session.configOptions?.find((o) => o.id === "model" || o.category === "model");
      if (modelOption) {
        await currentProfile.runtime.setConfigOption(session.sessionId, modelOption.id, model);
      }

      if (reasoningEffort) {
        const thoughtOption = session.configOptions?.find(
          (o) => o.id === "thought_level" || o.category === "thought_level",
        );
        if (thoughtOption) {
          const supported = thoughtOption.options?.map((opt) => String(opt.value)) ?? [];
          if (supported.includes(reasoningEffort)) {
            await currentProfile.runtime.setConfigOption(session.sessionId, thoughtOption.id, reasoningEffort);
          }
        }
      }

      // 2. Dispatch prompt
      const turn = currentProfile.runtime.prompt(session.sessionId, promptText, {
        signal: abortController.signal,
      });

      let accumulatedContent = "";

      // 3. Process incoming stream events
      for await (const update of turn.updates) {
        if (update.sessionUpdate === "agent_message_chunk") {
          const chunkText = extractChunkText(update.update);
          if (chunkText.length > 0) {
            // First content chunk commits the stream to the client
            if (!streamCommitted) {
              initSseStream(res, requestId);

              // 3a. response.created
              sendSseEvent(res, {
                type: "response.created",
                sequence_number: sequenceNumber++,
                response: {
                  id: responseId,
                  object: "response",
                  created_at: createdAt,
                  completed_at: null,
                  status: "in_progress",
                  model,
                  output: [],
                  output_text: "",
                  error: null,
                  incomplete_details: null,
                  instructions,
                  metadata,
                  parallel_tool_calls: false,
                  temperature: null,
                  tool_choice: "auto",
                  tools: [],
                  top_p: null,
                  previous_response_id: previousResponseId,
                },
              });

              // 3b. response.output_item.added
              sendSseEvent(res, {
                type: "response.output_item.added",
                sequence_number: sequenceNumber++,
                output_index: 0,
                item: {
                  id: messageId,
                  type: "message",
                  status: "in_progress",
                  role: "assistant",
                  content: [],
                },
              });

              // 3c. response.content_part.added
              sendSseEvent(res, {
                type: "response.content_part.added",
                sequence_number: sequenceNumber++,
                output_index: 0,
                item_id: messageId,
                content_index: 0,
                part: {
                  type: "output_text",
                  text: "",
                  annotations: [],
                },
              });

              streamCommitted = true;
            }

            // 3d. response.output_text.delta
            sendSseEvent(res, {
              type: "response.output_text.delta",
              sequence_number: sequenceNumber++,
              output_index: 0,
              item_id: messageId,
              content_index: 0,
              delta: chunkText,
              logprobs: [],
            });

            accumulatedContent += chunkText;
          }
        }
        // Note: agent_thought_chunk, tool_call, tool_call_update are filtered out
      }

      const promptResult = await turn.result;
      const usage = mapToResponseUsage(promptResult.usage);
      const completedAt = Math.floor(Date.now() / 1000);

      // If no chunk was emitted at all, turn failed or quota was exhausted before any output
      if (!streamCommitted) {
        throw new Error(
          `Streaming response returned no content (stopReason: ${promptResult.stopReason}); possible quota exhausted or upstream error`,
        );
      }

      // 4. Final events sequence: text.done, content_part.done, output_item.done, completed
      sendSseEvent(res, {
        type: "response.output_text.done",
        sequence_number: sequenceNumber++,
        output_index: 0,
        item_id: messageId,
        content_index: 0,
        text: accumulatedContent,
        logprobs: [],
      });

      sendSseEvent(res, {
        type: "response.content_part.done",
        sequence_number: sequenceNumber++,
        output_index: 0,
        item_id: messageId,
        content_index: 0,
        part: {
          type: "output_text",
          text: accumulatedContent,
          annotations: [],
        },
      });

      const finalOutputItem: ResponseOutputMessage = {
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: accumulatedContent,
            annotations: [],
          },
        ],
      };

      sendSseEvent(res, {
        type: "response.output_item.done",
        sequence_number: sequenceNumber++,
        output_index: 0,
        item: finalOutputItem,
      });

      const completedResponse: ResponseObject = {
        id: responseId,
        object: "response",
        created_at: createdAt,
        completed_at: completedAt,
        status: "completed",
        model,
        output: [finalOutputItem],
        output_text: accumulatedContent,
        error: null,
        incomplete_details: null,
        instructions,
        metadata,
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
        previous_response_id: previousResponseId,
        ...(usage !== undefined ? { usage } : {}),
      };

      sendSseEvent(res, {
        type: "response.completed",
        sequence_number: sequenceNumber++,
        response: completedResponse,
      });

      res.end();

      currentProfile.markSuccess();

      // Store in ResponseRegistry if requested
      if (store) {
        responseRegistry.save({
          id: responseId,
          createdAt,
          completedAt,
          lastAccessedAt: Date.now(),
          model,
          previousResponseId,
          preferredProfileId: currentProfile.id,
          workspace,
          transcript: newTranscript,
          outputText: accumulatedContent,
          usage,
          status: "completed",
          instructions,
          metadata,
          store: true,
        });
      } else if (isNewChain) {
        fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
      }

      logger.info("Response streaming completed", {
        requestId,
        responseId,
        previousResponseId,
        profileId: currentProfile.id,
        requestedModel: model,
        stream: true,
        stopReason: promptResult.stopReason,
        ...(usage !== undefined
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
            }
          : {}),
      });

      if (attempt > 1) {
        context.metrics.recordFailover(attempt - 1);
      }
      if (usage) {
        context.metrics.recordTokens(usage.input_tokens, usage.output_tokens);
      }

      return; // Success
    } catch (turnError) {
      lastError = turnError;
      const classification = classifyProfileFailure(turnError);
      currentProfile.markFailure(classification.kind, turnError, classification.cooldownMs);

      logger.warn("Responses streaming turn encountered error", {
        requestId,
        responseId,
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
      lease.release();
    }
  }

  // If we reach here, all attempts failed before output commit
  if (!streamCommitted) {
    if (isNewChain && !store) {
      fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
    if (lastError instanceof NoAvailableProfileError) {
      sendError(
        res,
        serviceUnavailableError("No Antigravity profile is currently available to serve this model."),
        requestId,
      );
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
  usage?: ResponseUsage | undefined;
  profileId: string;
}

async function executeTurnOnProfile(options: {
  profile: ProfileRuntime;
  model: string;
  promptText: string;
  workspace: string;
  reasoningEffort?: ResponseReasoningEffort | undefined;
  signal: AbortSignal;
  logger: RequestContext["logger"];
}): Promise<TurnExecutionResult> {
  const { profile, model, promptText, workspace, reasoningEffort, signal } = options;

  const session = await profile.runtime.newSession({ cwd: workspace });

  const targetMode = profile.config.sessionMode ?? "yolo";
  const availableModes = session.modes?.availableModes.map((m) => m.id) ?? [];
  if (availableModes.includes(targetMode)) {
    await profile.runtime.setMode(session.sessionId, targetMode);
  }

  const modelOption = session.configOptions?.find((o) => o.id === "model" || o.category === "model");
  if (modelOption) {
    await profile.runtime.setConfigOption(session.sessionId, modelOption.id, model);
  }

  if (reasoningEffort) {
    const thoughtOption = session.configOptions?.find(
      (o) => o.id === "thought_level" || o.category === "thought_level",
    );
    if (thoughtOption) {
      const supported = thoughtOption.options?.map((opt) => String(opt.value)) ?? [];
      if (supported.includes(reasoningEffort)) {
        await profile.runtime.setConfigOption(session.sessionId, thoughtOption.id, reasoningEffort);
      }
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
  const usage = mapToResponseUsage(promptResult.usage);

  return {
    assistantContent,
    stopReason: promptResult.stopReason,
    ...(usage !== undefined ? { usage } : {}),
    profileId: profile.id,
  };
}

function sendSseEvent(res: import("node:http").ServerResponse, event: ResponseStreamServerEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function mapToResponseUsage(promptUsage?: PromptUsage): ResponseUsage | undefined {
  if (!promptUsage) return undefined;

  const promptTokens = promptUsage.inputTokens;
  const completionTokens = promptUsage.outputTokens;
  let totalTokens = promptUsage.totalTokens;

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  const p = promptTokens ?? 0;
  const c = completionTokens ?? 0;
  const t = totalTokens ?? (p + c);

  return {
    input_tokens: p,
    output_tokens: c,
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

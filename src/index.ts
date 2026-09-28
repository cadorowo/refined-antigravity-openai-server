export { createRuntimeConnector, getProfileSessionUsage } from "./upstream/refined-antigravity.js";
export type { AcpConnector, AcpStreamMessage, ExtractedSessionUsage } from "./upstream/refined-antigravity.js";

export {
  AcpRuntimeClient,
  NoopLogger,
  type AcpRuntimeClientOptions,
} from "./acp/runtime-client.js";

export {
  PolicyPermissionHandler,
  CallbackPermissionHandler,
  createPermissionHandler,
  type PermissionHandler,
  type PermissionPolicy,
  type PermissionRequest,
  type PermissionDecision,
  type PermissionDecisionOutcome,
  type PermissionOption,
  type ToolCallInfo,
  type PolicyPermissionHandlerOptions,
} from "./acp/permission-handler.js";

export {
  AcpRuntimeError,
  RuntimeClosedError,
  RuntimeNotStartedError,
  ConcurrentTurnError,
  AcpRequestError,
  AcpTimeoutError,
  UnsupportedClientMethodError,
  PermissionDecisionError,
} from "./acp/errors.js";

export {
  AsyncQueue,
  normalizeUsage,
  type AcpConnectorFn,
  type AcpStreamPair,
  type ClientCapabilities,
  type ClientInfo,
  type InitializeResult,
  type NewSessionOptions,
  type SessionState,
  type SessionMode,
  type SessionConfigOption,
  type SessionModel,
  type PromptTurn,
  type PromptResult,
  type PromptUsage,
  type NormalizedUsage,
  type PromptOptions,
  type PromptInput,
  type SessionUpdate,
  type RuntimeLogger,
} from "./acp/runtime-types.js";

export {
  runHeadlessAcpProbe,
  type HeadlessAcpProbeOptions,
  type HeadlessAcpProbeReport,
} from "./diagnostics/headless-acp-probe.js";

export {
  runPermissionModeProbe,
  type PermissionModeProbeOptions,
  type PermissionModeProbeReport,
  type ModeProbeResult,
  type ObservedPermissionRequest,
} from "./diagnostics/permission-mode-probe.js";

export {
  ProfileRuntime,
  type ProfileRuntimeOptions,
} from "./profiles/profile-runtime.js";

export {
  ProfileManager,
  NoAvailableProfileError,
} from "./profiles/profile-manager.js";

export {
  classifyProfileFailure,
} from "./profiles/failure-classifier.js";

export type {
  ProfileId,
  ProfileState,
  ProfileFailureKind,
  ProfileFailureClassification,
  ProfileConfig,
  ProfileSnapshot,
  ProfileLease,
  AcquireOptions,
  FailoverOptions,
} from "./profiles/types.js";

export {
  runProfileIsolationProbe,
  type ProfileTarget,
  type ProfileProbeOptions,
  type SingleProfileProbeResult,
  type ProfileIsolationProbeReport,
} from "./diagnostics/profile-isolation-probe.js";

// Phase 3: HTTP Server & OpenAI Compatibility Layer
export {
  createServer,
  RefinedOpenAiServer,
  DefaultServerLogger,
  NoopServerLogger,
  type CreateServerOptions,
} from "./server/server.js";

export {
  ConfigurationError,
  expandPath,
  isLoopbackHost,
  validateConfig,
  loadConfigFromEnv,
  type ServerConfig,
  type ServerConfigInput,
} from "./server/config.js";

export { verifyBearerAuth } from "./server/auth.js";

export {
  generateRequestId,
  readJsonBody,
  sendJson,
  sendError,
  initSseStream,
  type RequestContext,
  type ServerLogger,
} from "./server/request-context.js";

export {
  ModelCatalog,
  extractModelsFromSession,
  type ModelCatalogOptions,
  type ProfileModelDiscoveryFn,
  type ModelCatalogLogger,
} from "./openai/models.js";

export {
  OpenAIHttpError,
  createOpenAiErrorPayload,
  invalidApiKeyError,
  routeNotFoundError,
  modelNotFoundError,
  methodNotAllowedError,
  payloadTooLargeError,
  serviceUnavailableError,
  internalServerError,
} from "./openai/errors.js";

export type {
  OpenAIModel,
  OpenAIModelList,
  OpenAIErrorObject,
  OpenAIErrorResponse,
  ChatCompletionRole,
  ChatCompletionContentPart,
  ChatCompletionTextContentPart,
  ChatCompletionMessageInput,
  StreamOptions,
  ChatCompletionRequest,
  ChatCompletionChoice,
  ChatCompletionUsage,
  ChatCompletionResponse,
  ChatCompletionChunkDelta,
  ChatCompletionChunkChoice,
  ChatCompletionChunk,
} from "./openai/types.js";

// Phase 4: Chat Completions Validation & Conversion
export { validateChatCompletionRequest } from "./openai/chat-validator.js";
export {
  convertOpenAiMessages,
  serializeConversation,
  extractTextContent,
  type ConvertedMessages,
} from "./openai/message-converter.js";
export { handleChatCompletions } from "./server/routes/chat-completions.js";


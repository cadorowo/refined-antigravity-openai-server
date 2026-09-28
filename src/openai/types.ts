export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIErrorObject {
  message: string;
  type: string;
  param: string | null;
  code: string;
}

export interface OpenAIErrorResponse {
  error: OpenAIErrorObject;
}

// Phase 4: Chat Completions types
export type ChatCompletionRole = "system" | "developer" | "user" | "assistant";

export interface ChatCompletionTextContentPart {
  type: "text";
  text: string;
}

export type ChatCompletionContentPart =
  | ChatCompletionTextContentPart
  | { type: string; [key: string]: unknown };

export interface ChatCompletionMessageInput {
  role: string;
  content: string | ChatCompletionContentPart[];
  name?: string | undefined;
}

export interface StreamOptions {
  include_usage?: boolean | undefined;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessageInput[];
  stream?: boolean | undefined;
  reasoning_effort?: "low" | "medium" | "high" | undefined;
  stream_options?: StreamOptions | undefined;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
  };
  finish_reason: string;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage | undefined;
}

export interface ChatCompletionChunkDelta {
  role?: "assistant" | undefined;
  content?: string | undefined;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage | undefined;
}

// Phase 5: Responses API types

export type ResponseRole = "system" | "developer" | "user" | "assistant";

export interface ResponseTextContentPart {
  type: "input_text" | "text";
  text: string;
}

export type ResponseInputContentPart =
  | ResponseTextContentPart
  | { type: string; [key: string]: unknown };

export interface ResponseInputMessageItem {
  type?: "message" | undefined;
  role: string;
  content: string | ResponseInputContentPart[];
  name?: string | undefined;
  [key: string]: unknown;
}

export type ResponseInputItem = string | ResponseInputMessageItem;

export type ResponseReasoningEffort = "low" | "medium" | "high";

export interface ResponseReasoningConfig {
  effort?: ResponseReasoningEffort | undefined;
  [key: string]: unknown;
}

export interface ResponseCreateRequest {
  model: string;
  input: string | ResponseInputItem[];
  instructions?: string | null | undefined;
  previous_response_id?: string | null | undefined;
  stream?: boolean | undefined;
  reasoning?: ResponseReasoningConfig | null | undefined;
  reasoning_effort?: ResponseReasoningEffort | undefined;
  store?: boolean | undefined;
  metadata?: Record<string, string> | null | undefined;
  [key: string]: unknown;
}

export interface ResponseOutputText {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface ResponseOutputMessage {
  id: string;
  type: "message";
  status: "completed" | "in_progress" | "incomplete";
  role: "assistant";
  content: ResponseOutputText[];
}

export type ResponseOutputItem = ResponseOutputMessage;

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number | undefined;
  } | undefined;
  output_tokens_details?: {
    reasoning_tokens?: number | undefined;
  } | undefined;
}

export type ResponseStatus =
  | "completed"
  | "in_progress"
  | "incomplete"
  | "failed"
  | "cancelled";

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  completed_at?: number | null | undefined;
  status: ResponseStatus;
  model: string;
  output: ResponseOutputItem[];
  output_text: string;
  error: { code: string; message: string } | null;
  incomplete_details: null;
  instructions: string | null;
  metadata: Record<string, string> | null;
  parallel_tool_calls: boolean;
  temperature: number | null;
  tool_choice: string;
  tools: unknown[];
  top_p: number | null;
  previous_response_id?: string | null | undefined;
  usage?: ResponseUsage | undefined;
}

// Streaming event types
export interface ResponseCreatedEvent {
  type: "response.created";
  sequence_number: number;
  response: ResponseObject;
}

export interface ResponseOutputItemAddedEvent {
  type: "response.output_item.added";
  sequence_number: number;
  output_index: number;
  item: ResponseOutputItem;
}

export interface ResponseContentPartAddedEvent {
  type: "response.content_part.added";
  sequence_number: number;
  output_index: number;
  item_id: string;
  content_index: number;
  part: ResponseOutputText;
}

export interface ResponseTextDeltaEvent {
  type: "response.output_text.delta";
  sequence_number: number;
  output_index: number;
  item_id: string;
  content_index: number;
  delta: string;
  logprobs: unknown[];
}

export interface ResponseTextDoneEvent {
  type: "response.output_text.done";
  sequence_number: number;
  output_index: number;
  item_id: string;
  content_index: number;
  text: string;
  logprobs: unknown[];
}

export interface ResponseContentPartDoneEvent {
  type: "response.content_part.done";
  sequence_number: number;
  output_index: number;
  item_id: string;
  content_index: number;
  part: ResponseOutputText;
}

export interface ResponseOutputItemDoneEvent {
  type: "response.output_item.done";
  sequence_number: number;
  output_index: number;
  item: ResponseOutputItem;
}

export interface ResponseCompletedEvent {
  type: "response.completed";
  sequence_number: number;
  response: ResponseObject;
}

export type ResponseStreamServerEvent =
  | ResponseCreatedEvent
  | ResponseOutputItemAddedEvent
  | ResponseContentPartAddedEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent
  | ResponseContentPartDoneEvent
  | ResponseOutputItemDoneEvent
  | ResponseCompletedEvent;


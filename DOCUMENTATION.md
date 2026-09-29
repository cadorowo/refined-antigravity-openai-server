# refined-antigravity-openai-server — Project Documentation

> **Canonical project document.**
>
> This file is the maintained source of truth for the project. Every agent working on the repository MUST update this document before finishing a phase or making an architectural change.

---

## 0. Documentation Maintenance Rules

This document follows a **maintain-don’t-accumulate** approach.

When updating it:

1. **Update existing sections in place.** Do not append duplicate summaries of old information.
2. **Keep current truth separate from historical notes.** Main sections describe the architecture as it exists now.
3. **Verified facts > assumptions.** Mark anything not empirically tested as `UNVERIFIED`.
4. **Keep implementation details concise.** Reference files/modules rather than copying large code blocks.
5. **Every completed phase must update:** `Current Status`, `Architecture`, relevant feature sections, `Tests & Validation`, `Known Limitations`, `Phase Roadmap`, and `Last Updated`.
6. **Do not store secrets here.** Never include OAuth tokens, API keys, `acp_token.json` contents, cookies, credentials, or sensitive paths.
7. **Do not document speculative APIs as implemented.** Planned features belong under `Phase Roadmap` or `Open Decisions`.

---

# 1. Project Goal

`refined-antigravity-openai-server` is a companion server built on top of `@simonepri/refined-antigravity-acp`.

Its goal is to expose Google Antigravity / AGY through an **OpenAI-compatible HTTP API** while preserving:

- upstream updateability;
- clean isolation from upstream internals;
- headless AGY execution;
- multi-profile / multi-account support;
- safe profile failover;
- OpenAI SDK compatibility;
- minimal architecture and dependencies.

The project MUST remain a **separate companion repository**.

---

# 2. Core Architectural Principles

## 2.1 Upstream isolation

Only the upstream adapter layer should know directly about `@simonepri/refined-antigravity-acp`.

Current boundary: `src/upstream/refined-antigravity.ts`

Other modules should depend on project-owned abstractions whenever practical. Do not import upstream internal paths.

## 2.2 One foreground turn per runtime

Each `AcpRuntimeClient` supports **1 active foreground prompt** at a time.

Parallelism is achieved using multiple profile runtimes, not concurrent foreground turns on a single connector.

## 2.3 Multi-profile instead of login swapping

Do NOT implement `logout A -> login B -> logout B -> login A`.

Instead use:

- one AGY child process per profile;
- one isolated `GEMINI_HOME` per profile;
- one `AcpRuntimeClient` per profile;
- one `ProfileRuntime` per profile;
- routing through `ProfileManager`.

## 2.4 Stateless Chat Completions

Planned / Phase 4 invariant:

`1 POST /v1/chat/completions = 1 ephemeral ACP session`

The OpenAI client already sends the conversation history in `messages[]`. Do not automatically reuse ACP sessions for Chat Completions.

## 2.5 Conservative failover

Transparent failover is allowed only for errors confidently classified as retryable.

Current classes:

- `rate_limit`
- `quota_exhausted`
- `auth`
- `transient`
- `fatal / unknown`

Unknown or fatal errors MUST NOT be silently retried on another profile.

For future streaming responses:

- before external output commit -> failover may be allowed;
- after the first committed content chunk -> no transparent replay.

---

# 3. Current Status

## Phase 1 — Headless ACP Probe

**Status: COMPLETE**

Verified:

- AGY works headlessly through ACP.
- Filesystem operations are executed internally by AGY.
- Terminal execution is handled internally by AGY.
- No client-side `fs/*` host is required.
- No client-side `terminal/*` host is required.
- `session/request_permission` is the relevant agent -> client RPC in permissioned modes.
- `session/prompt` result / `stopReason` is authoritative for turn completion.
- `tool_call_update.status` is telemetry only and may be inconsistent with real tool execution.
- real usage information is available.

## Phase 2 — AcpRuntimeClient

**Status: COMPLETE**

Implemented:

- single centralized ACP reader loop;
- JSON-RPC request/response correlation;
- session update routing;
- prompt lifecycle;
- cancellation;
- unknown method handling;
- permission handling;
- cleanup;
- single-flight startup;
- one foreground prompt per runtime;
- typed runtime errors;
- multi-instance-safe design.

The runtime is deliberately unaware of multi-profile scheduling.

## Phase 2.5 — Multi-Profile / Multi-Account

**Status: COMPLETE**

Implemented:

- `ProfileRuntime`;
- `ProfileManager`;
- per-profile AGY child process;
- per-process `GEMINI_HOME`;
- exclusive profile leases;
- profile states;
- priority routing;
- session affinity foundation;
- conservative failure classification;
- safe profile failover foundation;
- profile authentication helper;
- concurrent isolation probe.

Live verification with two profiles confirmed:

- both AGY processes can run concurrently;
- isolated workspaces;
- isolated `GEMINI_HOME`;
- distinct credential state;
- independent ACP sessions;
- successful file execution;
- successful terminal execution;
- `stopReason: end_turn` on both profiles.

No global `process.env.GEMINI_HOME` mutation is used.

## Phase 3 — HTTP Server Base

**Status: COMPLETE**

Implemented:

- native Node.js `node:http` server;
- non-singleton `createServer(...)`;
- centralized config;
- Bearer authentication;
- timing-safe API-key comparison;
- request IDs;
- body byte limits;
- OpenAI-compatible error envelope;
- graceful shutdown;
- `/healthz`;
- `/v1/models`;
- `/v1/models/:model`;
- dynamic AGY model discovery;
- cross-profile model catalog;
- OpenAI SDK model discovery compatibility.

Current real model discovery has returned:

- `gemini-3.8-flash`
- `gemini-3.7-flash`
- `gemini-3.6-flash`
- `gemini-3.1-pro`

These IDs MUST remain dynamically discovered rather than hardcoded.

## Phase 4 — Chat Completions

**Status: COMPLETE**

Implemented & Verified:

- `POST /v1/chat/completions` endpoint supporting non-streaming and Server-Sent Events (SSE) streaming;
- Message conversion and normalization for `system`, `developer`, `user`, and `assistant` text messages;
- Dynamic model-aware profile routing (`ModelCatalog` -> eligible profile IDs -> `ProfileManager`);
- Reasoning effort configuration option (`low`, `medium`, `high`);
- Authentic token usage propagation across isolated profiles via `getProfileSessionUsage` extracting from SQLite database without cross-profile pollution;
- Three-tier usage resolution precedence: authoritative `rawResult.usage` -> `usageResolver(sessionId)` SQLite extraction -> cumulative `usage_update`;
- Safe usage normalization: authentic token metrics mapped (`prompt_tokens`, `completion_tokens`, `total_tokens`), and omitted completely when genuinely unavailable (never fake `0/0/0` zeroes);
- Streaming SSE: initial role chunk, delta content chunks, terminal finish chunk, and conditional usage chunk when `stream_options.include_usage: true`;
- Client disconnect handling: `res.on("close")` triggers `AbortSignal` -> `session/cancel` -> profile lease release;
- Safe profile failover: pre-output failover across eligible profiles; strictly no transparent replay once stream is committed;
- Full official OpenAI Node SDK non-streaming and streaming compatibility verified against real Google Antigravity accounts.

## Phase 5 — Responses API

**Status: COMPLETE**

Implemented & Verified:

- `POST /v1/responses` endpoint supporting non-streaming and Server-Sent Events (SSE) streaming;
- `GET /v1/responses/:response_id` endpoint for response retrieval;
- Typed SSE streaming protocol (`response.created`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.output_text.done`, `response.content_part.done`, `response.output_item.done`, `response.completed`) with strictly increasing monotonic sequence numbering (`sequence_number: 0, 1, 2, ...`);
- Stateful conversation continuation via `previous_response_id` reconstructing full conversation transcripts across fresh per-turn ACP sessions;
- In-memory bounded `ResponseRegistry` with configurable capacity and TTL eviction (`REFINED_AGY_RESPONSE_REGISTRY_MAX_ENTRIES`, `REFINED_AGY_RESPONSE_REGISTRY_TTL_MS`);
- Parent record immutability supporting branching conversation trees from common ancestors without cross-branch contamination;
- Server-managed chain workspaces (`/tmp/refined-agy-chain-...`) reused across continuation turns, pinned while a continuation is active, and cleaned after the final record and active continuation release them;
- Profile affinity with conservative pre-output failover (preferred profile reused if available; fails over to healthy secondary profile before stream commit; strictly no post-output failover);
- Strict instruction isolation: instructions from previous turns are never replayed into AGY prompts; only new turn instructions are applied;
- Authentic token usage propagation (`input_tokens`, `output_tokens`, `total_tokens`) without fake zeroes;
- Full official OpenAI Node SDK 7.23+ compatibility: non-streaming `client.responses.create()`, streaming `client.responses.create({ stream: true })`, and retrieval `client.responses.retrieve()`;
- Full regression verification: `client.chat.completions.create` remains 100% operational.

## Phase 6 — Operational Hardening, Packaging & Validation

**Status: COMPLETE**

Implemented & Verified:

- Semantic health split: `/healthz` (lightweight liveness probe, returns 200 while process is alive, non-blocking) and `/readyz` (readiness probe, returns 200 only if $\ge 1$ profile is in `ready` state and server is not draining; returns 503 if all profiles are busy/exhausted/cooling down or server is shutting down);
- Protected `/status` operational diagnostics endpoint (authenticated with Bearer token matching `REFINED_AGY_API_KEY` when configured; returns sanitized `RuntimeMetrics` and profile snapshots with no secrets, tokens, or absolute paths);
- Production runtime metrics (`RuntimeMetrics` in `src/server/metrics.ts`): tracks uptime, total requests, active requests, error counts, status code breakdown, route distribution, input/output/total token counts, active stream counts, latency statistics (avg, min, max), and process memory (`rss`, `heapUsed`, `heapTotal`, `external`);
- Secret redaction and sanitized logging (`DefaultServerLogger` in `src/server/logger.ts`): automatic pattern redaction for Bearer tokens, OAuth tokens, authorization headers, absolute paths, and cookies across all log levels and structured metadata;
- Bounded profile recovery and restart (`ProfileRuntime.restart()` and `ProfileManager.restartProfile(id)`): maximum 3 consecutive restart attempts with guards blocking attempts on `auth_required`, `quota_exhausted`, and active leases; concurrent restart calls share one attempt, and shutdown prevents replacement startup; restart attempts currently have no automatic backoff;
- Strict lease release invariants: guaranteed lease release via `try...finally` across normal turns, client disconnects/aborts (`session/cancel`), and upstream errors;
- Production packaging: containerized deployment via `Dockerfile` (Node 22 slim, non-root `node` user, pnpm build, built-in healthcheck), `.dockerignore`, and `docker-compose.yml` with host profile volume mounting;
- Multi-account pool expansion: 3rd Antigravity profile (`account-c`) authenticated under `~/.config/refined-agy/profiles/account-c/gemini`, integrated into auto-discovery, and verified with live multi-profile failover from quota-exhausted accounts;
- Concurrency and stress test suite (`bin/stress-test.ts` / `pnpm stress`): validates 5 operational scenarios (concurrency saturation across profiles, 503 capacity exhaustion rejection, mixed streaming workload, sequential soak, and metrics invariants);
- Current local test verification: 193 / 193 tests passing. A focused live smoke test on the local `google1` profile verified restart but stopped at model discovery because upstream returned `Authentication required`; the two-turn live Responses check could not complete. The earlier full end-to-end live smoke test (`bin/smoke-test-phase6.ts` / `pnpm smoke:phase6`) was not rerun for these changes.

---

# 4. Current Architecture

```text
OpenAI-compatible clients
          |
          v
    HTTP Server
    node:http
          |
    +-----+-----------------------+
    |                             |
    v                             v
Auth / Errors / Routing      ResponseRegistry (LRU / TTL)
    |                             | (previous_response_id)
    v                             v
ModelCatalog ------------> ProfileManager (Affinity / Priority / Leases)
                                 /      |       \
                                v       v        v
                          Profile A Profile B Profile C
                              |        |         |
                              v        v         v
                        ProfileRuntime ...
                              |
                              v
                        AcpRuntimeClient
                              |
                              v
                 @simonepri/refined-antigravity-acp
                              |
                              v
                    Google Antigravity Processes
```

---

# 5. ACP Runtime

## 5.1 Reader model

Each connector has exactly one central reader.

The runtime owns request correlation and session routing. Do not create a new `ReadableStream` reader for each prompt.

## 5.2 Turn completion

Authoritative: `session/prompt` response, especially `stopReason`.

Do NOT determine completion from `tool_call`, `tool_call_update`, or tool status transitions.

## 5.3 Cancellation

Prompt cancellation maps to `session/cancel`.

HTTP disconnect handling in later phases must propagate through `AbortSignal`.

Local ACP session metadata is removed after each ephemeral HTTP turn and model-discovery session. Closing the runtime clears any remaining session metadata.

---

# 6. Permission Model

Live mode probe results:

| Mode | Edit permission | Execute permission | Permission RPC count observed |
|---|---|---|---:|
| `default` | required | required | 2 |
| `auto_edit` | automatic | required | 1 |
| `yolo` | automatic | automatic | 0 |

Verified in `yolo`:

- file writes succeed;
- terminal commands execute;
- no interactive permission RPC is emitted;
- turn completes normally.

Recommended trusted/headless runtime policy:

```text
sessionMode = yolo
fallbackPermissionPolicy = reject
```

These remain separate concepts:

- AGY session mode controls whether AGY asks;
- fallback permission policy controls what the client does if AGY unexpectedly asks.

Do not remove `PermissionHandler`.

---

# 7. Multi-Profile Architecture

## 7.1 Per-process isolation

Each profile receives its own child environment, conceptually:

```ts
{
  ...process.env,
  GEMINI_HOME: profile.geminiHome
}
```

Do not mutate global `process.env.GEMINI_HOME`.
Startup validation rejects profiles that resolve to the same writable `GEMINI_HOME`, including existing symlink aliases, and rejects `env.GEMINI_HOME` overrides.

## 7.2 Profile states

Current profile state model:

- `ready`
- `busy`
- `cooldown`
- `quota_exhausted`
- `auth_required`
- `unhealthy`
- `disabled`

`busy` means healthy but temporarily unavailable.

## 7.3 Lease invariant

A profile is exclusively leased while performing a foreground turn. A leased profile must not receive another foreground turn. Release must be guaranteed via `finally`.

## 7.4 Failure behavior

### rate_limit
- temporary cooldown;
- eligible for failover.

### quota_exhausted
- mark exhausted;
- eligible for failover;
- do not invent reset timestamps.

### auth
- mark `auth_required`;
- eligible for failover.

### transient
- short cooldown/unhealthy transition;
- eligible for failover.

### fatal / unknown
- propagate;
- no automatic failover.

## 7.5 Affinity

The profile layer supports a preferred profile concept for stateful APIs (such as the Responses API). Chat Completions remain stateless.

## 7.6 Bounded Recovery & Restart

Profile runtimes can recover from transient child process crashes or IPC reader disconnections:

- **Bounded attempts**: Maximum 3 consecutive restart attempts (`maxRestartAttempts = 3`); no automatic backoff loop is implemented.
- **Fail-closed guards**: Restart is strictly prohibited if a profile is marked `auth_required` (needs user re-authentication) or `quota_exhausted` (needs provider quota reset).
- **Lease safety**: Restart rejects a profile with an active lease without dropping it. A profile is unavailable for new leases throughout restart and returns to `ready` after a successful replacement startup. Successful request processing resets the consecutive restart counter.
- **Concurrency and shutdown**: Concurrent restart calls share one in-flight operation. Shutdown waits for it and prevents a replacement runtime from becoming available.
- **Management API**: Exposed via `profileManager.restartProfile(profileId)`.

---

# 8. HTTP Server

## 8.1 Stack

Current stack: `node:http`

No Express / Fastify / Hono. No heavyweight HTTP framework should be added without a demonstrated need.

## 8.2 Configuration

Current configuration includes:

- `REFINED_AGY_HOST`
- `REFINED_AGY_PORT`
- `REFINED_AGY_API_KEY`
- `REFINED_AGY_BODY_LIMIT`
- `REFINED_AGY_PROFILES_FILE`
- `REFINED_AGY_ALLOW_INSECURE_BIND`
- `REFINED_AGY_SHUTDOWN_GRACE_MS`
- `REFINED_AGY_RESPONSE_REGISTRY_MAX_ENTRIES`
- `REFINED_AGY_RESPONSE_REGISTRY_TTL_MS`

Defaults:

```text
host = 127.0.0.1
port = 8787
body limit = 1 MiB
shutdown grace = 15000 ms
registry max entries = 1000
registry ttl = 3600000 ms (1 hour)
```

External non-loopback bind without authentication is fail-closed unless explicitly overridden.

## 8.3 Authentication & Sanitized Logging

When API key is configured, `/v1/*` and `/status` require:

```http
Authorization: Bearer <token>
```

API-key comparison uses timing-safe comparison with length checking.

Structured server logging (`DefaultServerLogger`) strictly sanitizes and redacts Authorization headers, Bearer tokens, OAuth tokens, session cookies, and absolute filesystem paths (`GEMINI_HOME`, workspace scratch directories) from all log outputs.

## 8.4 Operational & API Routes

### `GET /healthz` (Liveness Probe)

Lightweight, unauthenticated, non-blocking process health check.
Returns HTTP 200 `{ "status": "ok", "version": "...", "uptime": 12.34 }` as long as the Node.js process is responsive.

### `GET /readyz` (Readiness Probe)

Lightweight, unauthenticated readiness check for load balancers and orchestrators.
Returns HTTP 200 only if at least 1 Antigravity profile is in the `ready` state and the server is not draining.
Returns HTTP 503 (`status: "not_ready"`) if all profiles are busy, cooling down, quota-exhausted, auth-required, or if graceful shutdown is underway.

### `GET /status` (Operational Metrics & Diagnostics)

Protected operational diagnostic report. Requires Bearer authentication when `REFINED_AGY_API_KEY` is configured.
Returns:
- Uptime and process memory statistics (`rss`, `heapUsed`, `heapTotal`, `external`);
- Aggregated request metrics (total requests, active requests, error count, HTTP status breakdown, route distribution);
- Real token counters (`inputTokens`, `outputTokens`, `totalTokens`) and active stream count;
- Latency metrics (`avgMs`, `minMs`, `maxMs`);
- Profile pool state snapshots (`id`, `state`, `activeLeases`);
- Strictly redacts all secrets, tokens, and filesystem paths.

### `GET /v1/models`

OpenAI-compatible model list. Models are dynamically discovered from AGY.

### `GET /v1/models/:model`

Returns one OpenAI-compatible model object or `model_not_found`.

---

# 9. Model Catalog

Current implementation: `src/openai/models.ts`

Responsibilities:

- discover models from AGY;
- cache model list in memory;
- union model availability across healthy profiles;
- deduplicate model IDs;
- track profile support.

Important internal mapping:

```text
modelId -> Set<profileId>
```

A completion requesting a model must only route to profiles that actually expose that model.

## 9.1 Discovery sources

AGY has exposed models through:

- `session.models.availableModels`;
- model choices in `session.configOptions`.

Current discovery checks both. Do not hardcode currently observed IDs. Discovery leases the exact profile being queried; a busy profile keeps its last known model mapping and is retried on a later request after a short interval.

---

# 10. OpenAI Compatibility

## Currently verified

| Feature | Status |
|---|---|
| `GET /v1/models` | supported & verified |
| `GET /v1/models/:model` | supported & verified |
| OpenAI Node SDK `models.list()` | verified |
| OpenAI Node SDK `models.retrieve()` | verified |
| `POST /v1/chat/completions` (non-streaming) | supported & verified |
| `POST /v1/chat/completions` (SSE streaming) | supported & verified |
| Authentic token usage propagation | supported & verified |
| OpenAI Node SDK `chat.completions.create` | verified (non-streaming & streaming) |
| `POST /v1/responses` (non-streaming) | supported & verified |
| `POST /v1/responses` (SSE streaming) | supported & verified |
| `GET /v1/responses/:response_id` | supported & verified |
| `previous_response_id` multi-turn continuation & branching | supported & verified |
| OpenAI Node SDK `responses.create` | verified (non-streaming & streaming) |
| OpenAI Node SDK `responses.retrieve` | verified |

Current OpenAI error envelope:

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "param": null,
    "code": "..."
  }
}
```

Current HTTP/OpenAI error coverage includes:

- `400 bad_request` / `unsupported_parameter`
- `401 invalid_api_key`
- `404 route_not_found`
- `404 model_not_found`
- `404 response_not_found`
- `405 method_not_allowed`
- `413 payload_too_large`
- `429 rate_limit_exceeded`
- `500 internal_server_error`
- `503 service_unavailable`

---

# 11. Security Invariants

1. Default bind is loopback only.
2. External bind without auth is fail-closed unless explicitly overridden.
3. CORS wildcard is not enabled by default.
4. Request bodies are byte-limited.
5. Credentials remain outside repository artifacts.
6. `GEMINI_HOME` contents must never be packaged into release ZIPs.
7. API requests must not be allowed to choose arbitrary `cwd`, workspace root, or `GEMINI_HOME`.
8. Internal reasoning / chain-of-thought must never be exposed as OpenAI assistant content.
9. AGY internal coding tools are not OpenAI function calls.
10. `yolo` is intended only for trusted / isolated server runtimes.

---

# 12. Graceful Shutdown

Lifecycle:

```text
stop accepting new HTTP requests
-> drain active non-streaming and SSE streaming completions
-> wait up to shutdown grace period (shutdownGraceMs)
-> cancel remaining active turns via AbortController / session/cancel
-> release profile leases
-> ProfileManager.closeAll()
-> ProfileRuntime close
-> AcpRuntimeClient close
-> AGY child termination
```

In-flight SSE requests and completions are allowed to finish within `shutdownGraceMs`. If the grace period expires, remaining turns are aborted cleanly via cancellation and sockets closed without hanging.

---

# 13. Testing & Validation

## Phase 2.5

Multi-profile live probe confirmed:

- concurrent AGY processes;
- distinct sessions;
- distinct workspaces;
- distinct credential state;
- file output success;
- terminal success;
- `end_turn`.

## Phase 3

Current reported unit test status: **71 / 71 PASS**

Covered areas include:

- server config;
- auth;
- model catalog;
- HTTP server;
- permission handler;
- failure classifier;
- profile runtime;
- profile manager;
- ACP runtime.

Also verified:

- TypeScript typecheck: PASS
- build: PASS
- real HTTP smoke test: PASS
- two live profiles: PASS
- OpenAI Node SDK `models.list()`: PASS
- OpenAI Node SDK `models.retrieve()`: PASS

## Phase 4 & 4.1

Current unit test status: **109 / 109 PASS**

Covered areas include:

- chat completion request validation (`model`, `messages`, `stream`, `reasoning_effort`, `stream_options`);
- message conversion (`system`, `developer`, `user`, `assistant`, multi-turn formatting);
- non-streaming chat completions (`choices`, `message`, `finish_reason: "stop"`, model);
- streaming SSE (`chat.completion.chunk`, initial role chunk, content deltas, terminal stop, `data: [DONE]`);
- model-aware profile routing and failover within compatible profiles;
- pre-output transparent failover;
- strict non-failover once streaming output is committed;
- client abort and cancellation propagation (`session/cancel`);
- graceful shutdown with in-flight drain and timeout abort;
- usage normalization and validation (`normalizeUsage`);
- three-tier usage resolution precedence (`rawResult.usage` -> `usageResolver` -> `usage_update`);
- cumulative usage updates (latest value wins);
- unknown usage omission (never fake `0/0/0` zeroes);
- streaming SSE conditional usage chunk when `stream_options.include_usage: true`.

Real smoke test verified against live Google Antigravity profiles (`pnpm smoke:phase4`):

- dynamic model discovery from AGY: PASS
- real non-streaming `POST /v1/chat/completions`: PASS with authentic token counts (`prompt_tokens: 18871, completion_tokens: 7, total_tokens: 18878`)
- real streaming SSE `POST /v1/chat/completions`: PASS with authentic token counts (`prompt_tokens: 18865, completion_tokens: 3, total_tokens: 18868`)
- official OpenAI Node SDK non-streaming `chat.completions.create`: PASS with authentic usage (`prompt_tokens: 18876, completion_tokens: 41, total_tokens: 18917`)
- official OpenAI Node SDK streaming `chat.completions.create`: PASS with authentic usage (`prompt_tokens: 18863, completion_tokens: 32, total_tokens: 18895`)

## Phase 5

Current unit test status: **150 / 150 PASS** across 5 test suites.

Covered areas include:
- Responses API request validation (`model`, `input`, `instructions`, `stream`, `store`, `metadata`, `previous_response_id`);
- Strict rejection (400) of unsupported parameters (`tools`, `tool_choice`, `parallel_tool_calls`, `background`, `max_output_tokens`, multimodal input parts);
- Conversation transcript reconstruction from stored `ResponseRecord` chain;
- Strict instruction isolation: past instructions are discarded, only current request instructions apply;
- Bounded in-memory `ResponseRegistry` capacity (`maxEntries`) with LRU eviction and TTL expiration (`ttlMs`);
- Parent record immutability and branching support;
- Server-managed chain workspace reuse and reference-counted cleanup;
- Responses non-streaming output (`object: "response"`, status, output message, usage);
- Responses typed SSE streaming with strictly monotonic sequence numbers (`sequence_number: 0, 1, 2, ...`);
- Monotonic SSE event sequence (`response.created` -> `response.output_item.added` -> `response.content_part.added` -> `response.output_text.delta`* -> `response.output_text.done` -> `response.content_part.done` -> `response.output_item.done` -> `response.completed`);
- Profile affinity: reusing same profile for continuation turns when available;
- Pre-output failover across eligible profiles on retryable error;
- Post-output failover boundary: strictly no transparent retry once stream commits;
- Response retrieval endpoint `GET /v1/responses/:response_id` (200 on hit, 404 `response_not_found` on miss).

Real smoke test verified against live Google Antigravity profiles (`pnpm smoke:phase5`):
- dynamic model discovery from AGY: PASS
- real non-streaming `POST /v1/responses`: PASS with authentic token counts (`input_tokens: 18873, output_tokens: 4, total_tokens: 18877`)
- real streaming SSE `POST /v1/responses`: PASS with authentic token counts (`input_tokens: 18866, output_tokens: 36, total_tokens: 18902`) and strict monotonic sequence numbering
- stateful multi-turn continuation with `previous_response_id` recalling stored secret codeword: PASS
- parent immutability & branching without cross-branch contamination: PASS
- official OpenAI Node SDK non-streaming `responses.create`: PASS (`input_tokens: 18880, output_tokens: 41, total_tokens: 18921`)
- official OpenAI Node SDK retrieval `responses.retrieve`: PASS
- official OpenAI Node SDK streaming `responses.create({ stream: true })`: PASS
- Phase 4 chat completion regression verification (`chat.completions.create`): PASS

## Phase 6

Current local test status: **189 / 189 PASS** (`pnpm test`).

Covered areas include:
- Operational health checks (`/healthz` liveness, `/readyz` readiness returning 200 when ready profiles exist and 503 when all busy/exhausted/draining);
- Runtime metrics aggregation (`RuntimeMetrics` requests, route breakdown, tokens, streams, latency summary, memory);
- Protected `/status` endpoint with Bearer auth verification and sanitized operational reporting (omits secrets, tokens, paths);
- Secret redaction and sanitized logging (`DefaultServerLogger` redacts Bearer tokens, OAuth credentials, authorization headers, paths);
- Bounded profile recovery and restarts (`ProfileRuntime.restart()` up to 3 attempts, blocked on auth/quota, lease released);
- Guaranteed lease release invariant across success, cancellation, abort, and unexpected runtime errors;
- Token usage propagation, failover counts, and stream tracking across `/v1/chat/completions` and `/v1/responses`;
- Server configuration validation and loopback security checks.

Concurrency & Stress Test Suite (`bin/stress-test.ts` / `pnpm stress`):
- **Scenario 1 (Concurrency Saturation)**: 2 simultaneous requests dispatched across 2 ready profiles execute in parallel and release leases to 0: PASS
- **Scenario 2 (Capacity Exhaustion)**: 3 simultaneous requests against 2 profiles; 2 succeed concurrently, 3rd immediately receives 503 Service Unavailable: PASS
- **Scenario 3 (Mixed Streaming Workload)**: Concurrent Chat Completion SSE stream + Responses API SSE stream running in parallel: PASS
- **Scenario 4 (Sequential Soak)**: 5 sequential completion turns completing cleanly with invariant lease assertions: PASS
- **Scenario 5 (Status Report Invariants)**: `/status` accurately reflects metrics (15 requests, 1 error, latency average/min/max, memory RSS/heap, zero leaked leases): PASS

Real 3-Profile Live Smoke Test (`bin/smoke-test-phase6.ts` / `pnpm smoke:phase6`):
- Multi-account setup: `account-a` and `account-b` (both hit daily quota limit) + newly authenticated `account-c`;
- `/healthz` returns 200 OK: PASS
- `/readyz` returns 200 OK with ready profiles: PASS
- Dynamic model discovery from AGY: PASS
- Automated multi-profile failover: request to `account-a` encounters quota limit -> transparently fails over to `account-b` -> encounters quota limit -> transparently fails over to `account-c` -> successfully completes with HTTP 200 and authentic token metrics: PASS
- OpenAI Node SDK Chat Completion with failover to `account-c`: PASS
- OpenAI Node SDK Responses API continuation and retrieval with failover to `account-c`: PASS
- Protected `/status` returns authenticated metrics and 3-profile pool status snapshot: PASS

---

# 14. Phase 4 Implementation & Architecture

`POST /v1/chat/completions` provides stateless, OpenAI-compatible chat completions over headless AGY instances.

## 14.1 Request processing & validation

Implemented in `src/openai/chat-validator.ts` and `src/openai/message-converter.ts`:

- `model`: validated against dynamic `ModelCatalog`;
- `messages`: supports `system`, `developer`, `user`, and `assistant` text messages;
- `reasoning_effort`: optionally maps to `thought_level` config option (`low`, `medium`, `high`);
- `stream`: selects streaming vs non-streaming flow;
- `stream_options.include_usage`: toggles terminal usage chunk emission in SSE mode.

## 14.2 Model-aware profile routing

```text
requested model
      |
      v
ModelCatalog
      |
      v
eligible profile IDs
      |
      v
ProfileManager
```

Failover remains strictly inside the compatible profile set. If no profile supports the model, returns `503 Service Unavailable`.

## 14.3 Authentic usage propagation (Phase 4.1)

Upstream `agy_acp_server` records token counts in SQLite databases located at `<profileGeminiHome>/antigravity-acp/conversations/<sessionId>.db`.

In multi-profile setups, `ProfileRuntime` isolates child processes by injecting `GEMINI_HOME: profile.geminiHome` while keeping parent Node `process.env.GEMINI_HOME` unpolluted.

Resolution precedence:
1. `rawResult.usage`: Authoritative usage directly reported on `session/prompt` response;
2. `usageResolver(sessionId)`: Fallback query directly extracting from profile SQLite DB via `getProfileSessionUsage(sessionId, geminiHome)`;
3. Cumulative `usage_update`: Fallback using latest cumulative update from `session/update` notifications;
4. Unknown / unavailable: If no token metrics are present, `usage` is omitted entirely from the response; fake `0/0/0` zeroes are strictly forbidden.

Mapping:

```text
inputTokens  -> prompt_tokens
outputTokens -> completion_tokens
totalTokens  -> total_tokens
```

## 14.4 Streaming SSE

Only `agent_message_chunk` is forwarded as assistant content delta. Internal reasoning chunks (`agent_thought_chunk`), tool execution, and permissions are never leaked into assistant output.

Event structure:
1. Initial chunk with `delta: { role: "assistant" }`;
2. Incremental chunks with `delta: { content: "..." }`;
3. Stop chunk with `finish_reason: "stop"` (or stopReason);
4. Optional usage chunk if `stream_options.include_usage: true` and usage is available;
5. Terminal `data: [DONE]`.

SSE writes wait for Node's `drain` event when the HTTP writable buffer fills; disconnect or abort ends that wait. The ACP update queue does not yet provide end-to-end backpressure to the upstream process.

## 14.5 Streaming failover boundary

Before first committed content delta: `transparent failover allowed`.

After first committed content delta: `transparent failover forbidden`. Once bytes have been flushed to the client, the stream aborts cleanly on error without attempting cross-profile replay.

## 14.6 Disconnect behavior

```text
HTTP client disconnect (res.on("close"))
-> AbortController.abort()
-> session/cancel notification
-> release profile lease
-> remove temporary scratch directory
```

---

---

# 15. Phase 5 Implementation & Architecture — Responses API

`POST /v1/responses` and `GET /v1/responses/:response_id` implement the OpenAI Responses API for text generations over headless AGY instances with stateful conversation continuation.

## 15.1 Response Registry & Lifecycle

Implemented in `src/openai/response-registry.ts`:
- **In-memory bounded storage**: Stores completed response records (`ResponseRecord`) indexing conversation transcripts, instructions, output text, profile ID, and managed workspace directories.
- **LRU and TTL eviction**: Configurable via `responseRegistryMaxEntries` (default: 1000) and `responseRegistryTtlMs` (default: 1 hour).
- **Ephemeral handling**: Requests with `store: false` skip registry storage; ephemeral responses are returned to the client and discarded immediately.
- **Reference-counted workspaces**: Chain workspace directories (`/tmp/refined-agy-chain-...`) track active references across branched trees and are automatically unlinked (`fs.rm`) once all referencing responses are evicted or deleted.
- New chain workspaces are also removed when generation fails or `store: false` prevents registry insertion.

## 15.2 Stateful Context Reconstruction & Chain Workspaces

Implemented in `src/openai/response-converter.ts`:
- **Stateful continuation via `previous_response_id`**: Copies the parent record's self-contained transcript snapshot and appends the current turn (`NormalizedConversationMessage[]`).
- **Parent immutability & branching**: Parent response records are never mutated by continuation turns. Multiple child responses can branch from the same parent without state cross-contamination.
- **Per-turn fresh ACP sessions**: Rather than keeping long-lived, opaque ACP sessions open indefinitely, each turn executes in a fresh ACP session with reconstructed context and reuses the chain workspace directory.
- **Managed chain workspace**: File mutations performed by tool execution in earlier turns remain available to subsequent continuation turns.

## 15.3 Profile Affinity & Pre-Output Failover

Implemented in `src/server/routes/responses.ts`:
- **Profile affinity**: Continuation turns inspect the profile used by `previous_response_id` and pass it as `preferredProfileId` to `ProfileManager.leaseProfile(...)`. If the preferred profile is available and healthy, it is leased for the turn.
- **Pre-output failover**: If the preferred profile is busy, in cooldown, or throws a retryable error before any response content is flushed, the turn safely falls back to any other healthy profile supporting the requested model.
- **Post-output failover boundary**: Once the initial SSE stream headers or first response chunk commit to the client socket, failover is strictly forbidden to prevent corrupted or duplicate output.

## 15.4 SSE Event Protocol & Sequence Numbering

Responses API SSE streaming uses typed events rather than raw completion chunks:
- `response.created`: Initial response object with status `in_progress`.
- `response.output_item.added`: Message item addition with role `assistant`.
- `response.content_part.added`: Output text content part.
- `response.output_text.delta`: Text content delta chunks forwarded exclusively from `agent_message_chunk`.
- `response.output_text.done`: Completed output text.
- `response.content_part.done`: Completed content part.
- `response.output_item.done`: Completed output item.
- `response.completed`: Terminal event containing the final completed response object with authentic usage metrics.
- **Strict monotonic sequence numbering**: Every event carries a zero-indexed, strictly increasing integer `sequence_number` (0, 1, 2, ...).
- **No `[DONE]` event**: Compliant with official OpenAI Responses specification; streams terminate after `response.completed`.
- **HTTP backpressure**: Each SSE write waits for `drain` before the route consumes another ACP update; the upstream ACP update queue itself remains unbounded.

## 15.5 Instruction Isolation & Strict Validation

Implemented in `src/openai/response-validator.ts` and `src/openai/response-converter.ts`:
- **Instruction isolation**: Instructions provided in past turns (`resp_1`) are discarded from reconstructed prompts; only instructions provided on the current request are applied to the active turn.
- **Strict validation**: Rejects unsupported features (`tools`, `tool_choice`, `parallel_tool_calls`, `background`, `max_output_tokens`, `input_image`, `input_audio`) with HTTP 400 Bad Request to prevent silent divergence.
- **Reasoning isolation**: Internal reasoning tokens (`agent_thought_chunk`) and internal AGY tool executions are strictly filtered out; only final assistant output text is emitted.

---

# 16. Known Limitations

Current intentional limitations:

- no OpenAI function calling / tool calling API yet;
- no multimodal input yet (text-only input supported for Responses API);
- no external database or Redis for ResponseRegistry (bounded in-memory LRU/TTL store);
- no distributed profile pool (local processes only);
- no mid-stream transparent failover (failover is strictly forbidden after first output commit);
- no provider quota reset discovery yet.

---

# 17. Phase Roadmap

## Phase 1 — Headless ACP
`COMPLETE`

## Phase 2 — AcpRuntimeClient
`COMPLETE`

## Phase 2.5 — Multi-Profile
`COMPLETE`

## Phase 3 — HTTP + Models
`COMPLETE`

## Phase 4 — Chat Completions
`COMPLETE`

## Phase 5 — Responses API
`COMPLETE`

Implemented:

- `POST /v1/responses` (non-streaming and typed SSE streaming);
- `GET /v1/responses/:response_id` retrieval;
- stateful continuation via `previous_response_id` with chain context reconstruction;
- in-memory bounded `ResponseRegistry` with LRU/TTL eviction and workspace ref-counting;
- parent record immutability and multi-branch isolation;
- profile affinity with conservative pre-output failover;
- strict instruction isolation;
- authentic token usage propagation;
- official OpenAI Node SDK full compatibility (`create`, `retrieve`, streaming).

## Phase 6 — Hardening / Deployment
`COMPLETE`

Implemented:

- Operational split: `/healthz` (liveness) and `/readyz` (readiness);
- Protected `/status` diagnostics endpoint with Bearer auth;
- Runtime metrics aggregation (`RuntimeMetrics`) tracking requests, routes, tokens, active streams, latency average/min/max, and memory;
- Secret redaction across server logging (`DefaultServerLogger`);
- Bounded profile restarts (max 3, auth/quota protection);
- Guaranteed lease release invariant across success, cancellation, abort, disconnect;
- Packaging: `Dockerfile`, `.dockerignore`, `docker-compose.yml`;
- Concurrency & stress suite (`bin/stress-test.ts` / `pnpm stress`);
- 3rd AGY account (`account-c`) integration and live multi-profile failover validation.

## Future Enhancements / Post-Phase 6
`PLANNED`

- Function calling / tool use mapping to OpenAI client tools schema;
- Multimodal input support (images/audio) once upstream ACP supports input parts;
- External distributed state storage (e.g. SQLite/Redis) for multi-node deployments;
- Provider quota reset discovery.

---

# 18. Open Decisions

Keep this list short. Remove items when resolved.

### Responses session persistence

Resolved in Phase 5: implemented bounded in-memory `ResponseRegistry` with LRU and TTL eviction, with server configuration options (`REFINED_AGY_RESPONSE_REGISTRY_MAX_ENTRIES`, `REFINED_AGY_RESPONSE_REGISTRY_TTL_MS`). External persistent storage (SQLite/Redis) remains an optional future enhancement for distributed setups.

### Queueing when compatible profiles are busy

Current preferred behavior: `503 immediately` rather than adding a complex queue. Re-evaluate only if real clients require queueing.

### Health/readiness split

Resolved in Phase 6: Implemented `/healthz` for process liveness (200 OK) and `/readyz` for traffic readiness (200 OK when $\ge 1$ profile ready and server not draining; 503 Service Unavailable otherwise).

### Quota reset recovery

Profile state supports quota exhaustion, but automatic reset timing is not yet derived from AGY. Do not invent reset schedules.

---

# 19. Files / Ownership

```text
src/upstream/
  upstream package boundary

src/acp/
  ACP transport/runtime abstraction

src/profiles/
  profile lifecycle, state, scheduling, failover

src/openai/
  OpenAI compatibility types/catalog/errors/conversion/validator/registry

src/server/
  HTTP transport, auth, config, routes

src/diagnostics/
  probes and verification utilities

bin/
  operational CLI entrypoints
```

Do not duplicate responsibilities across these directories.

---

# 20. Agent Completion Checklist

Before an agent says a phase is complete:

- [x] implementation finished;
- [x] no upstream patch introduced;
- [x] typecheck passes;
- [x] unit tests pass;
- [x] build passes;
- [x] relevant real smoke test executed when credentials/environment allow;
- [x] no secrets included in repository artifacts;
- [x] README updated if user-facing behavior changed;
- [x] this `DOCUMENTATION.md` updated in place;
- [x] `Phase Roadmap` updated;
- [x] `Known Limitations` updated;
- [x] `Last Updated` updated.

---

# 21. Last Updated

**2026-09-29**

Current canonical state:

`Phase 6 COMPLETE; independent review fixes for profile-home validation, ephemeral cleanup, model discovery, and HTTP SSE backpressure verified locally.`

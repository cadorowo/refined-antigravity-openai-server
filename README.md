# Refined Antigravity OpenAI Server

An OpenAI-compatible HTTP server for Google Antigravity / AGY, built on top of `@simonepri/refined-antigravity-acp`.

It exposes Antigravity through familiar OpenAI-style endpoints while adding:
- multi-account / multi-profile routing;
- isolated AGY runtimes;
- automatic failover;
- streaming;
- real token usage;
- stateful Responses API conversations;
- operational health and readiness checks;
- Docker deployment.

The project is intentionally implemented as a separate companion server, keeping the upstream ACP package clean and updateable.

## Features

### OpenAI-compatible APIs

Supported endpoints:
- `GET /v1/models`
- `GET /v1/models/:model`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/responses/:response_id`

Operational endpoints:
- `GET /healthz`
- `GET /readyz`
- `GET /status`

### Chat Completions

`POST /v1/chat/completions`

Supports:
- non-streaming responses;
- SSE streaming;
- system, developer, user, and assistant messages;
- dynamic model selection;
- reasoning effort;
- real token usage;
- cancellation on client disconnect;
- model-aware multi-profile routing;
- safe pre-output failover.

Compatible with the official OpenAI Node SDK.

### Responses API

`POST /v1/responses`

Supports:
- text input;
- non-streaming responses;
- typed Responses API streaming events;
- `previous_response_id`;
- stateful multi-turn continuation;
- conversation branching;
- profile affinity;
- workspace affinity;
- real token usage;
- response retrieval;
- in-memory response registry with TTL and bounded capacity.

Example:

```typescript
const first = await client.responses.create({
  model: "gemini-3.8-flash",
  input: "Remember the codeword ORBIT."
});

const second = await client.responses.create({
  model: "gemini-3.8-flash",
  previous_response_id: first.id,
  input: "What was the codeword?"
});

console.log(second.output_text);
```

## Multi-account architecture

Each Antigravity account runs inside its own isolated profile.

```text
                        OpenAI clients
                              │
                              ▼
                         HTTP Server
                              │
                        Model Catalog
                              │
                        ProfileManager
                     ┌────────┼────────┐
                     ▼        ▼        ▼
                 Profile A Profile B Profile C
                     │        │        │
                  AGY A    AGY B    AGY C
                     │        │        │
               GEMINI_HOME GEMINI_HOME GEMINI_HOME
                     A        B        C
```

Each profile has:
- its own `GEMINI_HOME`;
- its own AGY child process;
- its own `AcpRuntimeClient`;
- isolated authentication state;
- exclusive foreground-turn leasing.

Profiles can run concurrently on the same machine.
No logout/login swapping is required.

## Automatic failover

Profiles are tracked using operational states such as:
- `ready`
- `busy`
- `cooldown`
- `quota_exhausted`
- `auth_required`
- `unhealthy`
- `disabled`

Retryable failures can automatically move a request to another compatible profile.

Examples:
- **rate limit** $\to$ cooldown $\to$ try next compatible profile
- **quota exhausted** $\to$ exclude profile $\to$ try next compatible profile
- **authentication failure** $\to$ `auth_required` $\to$ try next compatible profile
- **transient connection failure** $\to$ temporary cooldown $\to$ try next compatible profile

Unknown or fatal errors are not silently retried.
For streaming requests, failover is only allowed before response content has been committed to the client.
The server never mixes generations from two profiles inside the same stream.

## Dynamic model discovery

Models are discovered directly from AGY.
Nothing is hardcoded.

Example models observed during development:
- `gemini-3.8-flash`
- `gemini-3.7-flash`
- `gemini-3.6-flash`
- `gemini-3.1-pro`

Availability can vary by account or upstream version.
Internally, the server tracks:
```text
model → compatible profile IDs
```
so requests are only routed to profiles that actually support the requested model.

## Installation

Requirements:
- Node.js
- pnpm
- Google Antigravity configured on the machine
- at least one authenticated AGY profile

Install dependencies:
```bash
pnpm install
```

Build:
```bash
pnpm build
```

Run:
```bash
pnpm serve
```

Default address:
```text
http://127.0.0.1:8787
```

## Configuration

Main environment variables:
- `REFINED_AGY_HOST`
- `REFINED_AGY_PORT`
- `REFINED_AGY_API_KEY`
- `REFINED_AGY_BODY_LIMIT`
- `REFINED_AGY_PROFILES_FILE`
- `REFINED_AGY_SHUTDOWN_GRACE_MS`

Responses registry configuration:
- `REFINED_AGY_RESPONSE_REGISTRY_MAX_ENTRIES`
- `REFINED_AGY_RESPONSE_REGISTRY_TTL_MS`

Default bind address:
`127.0.0.1`

The server intentionally does not bind publicly by default.

## Profiles

Profiles can be configured using a JSON configuration file.

Example:
```json
{
  "profiles": [
    {
      "id": "account-a",
      "geminiHome": "/path/to/profiles/account-a/gemini",
      "priority": 1,
      "enabled": true
    },
    {
      "id": "account-b",
      "geminiHome": "/path/to/profiles/account-b/gemini",
      "priority": 2,
      "enabled": true
    }
  ]
}
```

Then:
```bash
export REFINED_AGY_PROFILES_FILE=/path/to/profiles.json
```

Each profile must use a dedicated `GEMINI_HOME`.
Do not reuse one writable `GEMINI_HOME` across multiple concurrently running profiles.

## Authentication

When:
```bash
REFINED_AGY_API_KEY=your-secret-key
```
is configured, `/v1/*` and protected operational endpoints require:
```http
Authorization: Bearer your-secret-key
```

Example:
```bash
curl \
  -H "Authorization: Bearer your-secret-key" \
  http://127.0.0.1:8787/v1/models
```

API keys are compared using timing-safe comparison and are never intentionally logged.

## OpenAI SDK

### Node.js

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local-server-key",
  baseURL: "http://127.0.0.1:8787/v1"
});

const completion = await client.chat.completions.create({
  model: "gemini-3.8-flash",
  messages: [
    {
      role: "user",
      content: "Hello!"
    }
  ]
});

console.log(completion.choices[0].message.content);
```

### Streaming

```typescript
const stream = await client.chat.completions.create({
  model: "gemini-3.8-flash",
  messages: [
    {
      role: "user",
      content: "Hello!"
    }
  ],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(
    chunk.choices[0]?.delta?.content ?? ""
  );
}
```

### Responses API

```typescript
const response = await client.responses.create({
  model: "gemini-3.8-flash",
  input: "Explain this in one sentence."
});

console.log(response.output_text);
```

## Health and readiness

### Liveness

`GET /healthz`

Indicates that the server process is alive.
It does not require a profile to be immediately available.

### Readiness

`GET /readyz`

Returns ready only when at least one profile can accept new work.
Typical behavior:
- `200` $\to$ at least one profile available
- `503` $\to$ no profile currently available

A busy profile is considered healthy, but not currently allocatable.

### Operational status

`GET /status`

Protected by Bearer authentication.
Provides sanitized operational information such as:
- request counts;
- active requests;
- error counts;
- failovers;
- token totals;
- active streams;
- latency statistics;
- process memory;
- response registry size;
- profile states.

It does not expose credentials or authentication material.

## Real token usage

Token accounting comes from AGY / ACP rather than a local tokenizer.

Example:
```json
{
  "usage": {
    "prompt_tokens": 18871,
    "completion_tokens": 7,
    "total_tokens": 18878
  }
}
```

For the Responses API:
```json
{
  "usage": {
    "input_tokens": 18871,
    "output_tokens": 7,
    "total_tokens": 18878
  }
}
```

AGY token accounting may include internal agent context, system context, and tool-related context in addition to the literal user input.
If authentic usage is unavailable, the server does not fabricate 0 / 0 / 0.

## Concurrency

Each profile supports one foreground AGY turn at a time.
With multiple profiles, requests can run concurrently.

Example with two profiles:
- Request A $\to$ Profile A
- Request B $\to$ Profile B

If both profiles are occupied and another request arrives:
- Request C $\to$ HTTP 503

The server intentionally does not implement a complex request queue.

## Recovery

Profiles support bounded recovery from unexpected AGY/runtime failures.
The server distinguishes between failures that may benefit from restart and failures where restart would be pointless.

For example:
- unexpected child crash $\to$ bounded restart
- temporary ACP failure $\to$ recovery / cooldown
- `auth_required` $\to$ no restart loop
- `quota_exhausted` $\to$ no restart loop

Restart attempts are bounded to prevent infinite restart cycles.

## Graceful shutdown

On `SIGTERM` or `SIGINT`, the server:

```text
stops accepting new work
        ↓
becomes not-ready
        ↓
waits for active requests
        ↓
cancels remaining turns after grace timeout
        ↓
closes profile runtimes
        ↓
terminates AGY child processes
```

The grace period is configurable.

## Docker

The repository includes:
- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`

Build:
```bash
docker build -t refined-antigravity-openai-server .
```

Credentials must be mounted from the host.
They should never be baked into the image.

Example conceptual layout:

Host:
`~/.config/refined-agy/profiles/`

Container:
`/data/profiles/`

Your profile configuration should reference the paths visible inside the container.

## Security

Important: this is not a pure inference proxy.

Antigravity is an agent runtime.
Depending on configuration, AGY may execute:
- filesystem operations;
- shell commands;
- coding tools.

Headless profiles normally use AGY's `yolo` mode so requests do not block waiting for interactive permission prompts.
For that reason:
- bind to localhost unless remote access is intentionally configured;
- always use authentication for external access;
- isolate profiles;
- do not expose arbitrary workspace or `cwd` controls;
- do not expose `GEMINI_HOME` through requests;
- do not run the service with unnecessary filesystem privileges;
- treat the machine running AGY as a trusted execution environment.

The server intentionally fails closed for unsafe external binding configurations unless explicitly overridden.

## Current compatibility

| Feature | Status |
|---|:---:|
| `/v1/models` | ✅ |
| `/v1/models/:model` | ✅ |
| `/v1/chat/completions` | ✅ |
| Chat Completions streaming | ✅ |
| `/v1/responses` | ✅ |
| Responses streaming | ✅ |
| `previous_response_id` | ✅ |
| Responses branching | ✅ |
| Response retrieval | ✅ |
| Real token usage | ✅ |
| Multi-profile routing | ✅ |
| Profile failover | ✅ |
| OpenAI Node SDK | ✅ |
| OpenAI Python SDK | Not fully validated |
| Function calling / OpenAI tools | ❌ |
| Multimodal input | ❌ |
| Audio | ❌ |
| Image generation | ❌ |
| Persistent Responses storage | ❌ |
| Distributed profile pool | ❌ |

Unsupported parameters are rejected explicitly rather than silently ignored whenever practical.

## Testing

The project includes unit, integration, compatibility, stress, and live smoke tests.

Current validated areas include:
- ACP runtime
- permissions
- usage propagation
- multi-profile scheduling
- failure classification
- HTTP server
- authentication
- model discovery
- Chat Completions
- Responses API
- `previous_response_id`
- branching
- streaming
- cancellation
- profile affinity
- failover
- health/readiness
- runtime metrics
- recovery
- security
- concurrency

Phase 6 reached:
**183 / 183 tests passing**

Additional live validation has included multiple authenticated AGY profiles running concurrently.

## Stress behavior

Verified scenarios include:
- 2 ready profiles + 2 simultaneous requests $\to$ both succeed
- 2 ready profiles + 3 simultaneous requests $\to$ 2 succeed, 1 receives 503

Mixed concurrent Chat Completions and Responses streams have also been verified without cross-talk.

## Upstream compatibility

The project depends on:
`@simonepri/refined-antigravity-acp`
but does not patch it.

Upstream-specific behavior is intentionally isolated behind the adapter layer.
Important contracts monitored by the project include:
- `createAntigravityConnector`;
- custom process spawning;
- `session/new`;
- model configuration;
- reasoning configuration;
- session updates;
- permission requests;
- usage extraction.

The intended upgrade workflow is:
```text
upstream release
      ↓
compatibility checks
      ↓
typecheck + tests + build
      ↓
live smoke test
      ↓
version bump
```

## Project architecture

```text
src/
├── acp/
│   └── ACP runtime and transport abstractions
│
├── profiles/
│   └── profile lifecycle, leases, routing and failover
│
├── openai/
│   └── OpenAI compatibility, models and Responses state
│
├── server/
│   └── HTTP transport, auth, routes and operations
│
├── upstream/
│   └── refined-antigravity-acp integration boundary
│
└── diagnostics/
    └── probes and verification tooling
```

Each type of information or responsibility should have one clear owner.

## Design philosophy

The project deliberately favors:
- small abstractions;
- explicit behavior;
- empirical verification;
- minimal dependencies;
- isolation instead of global state;
- conservative retries;
- updateable upstream dependencies;
- maintain-don't-accumulate documentation.

Features are added when there is a demonstrated need rather than speculatively.

## Known limitations

- Responses state is currently in-memory.
- `previous_response_id` state is lost after server restart.
- No distributed response registry.
- No distributed profile scheduler.
- No OpenAI function calling.
- No multimodal API support.
- No automatic quota-reset discovery.
- Each profile supports one foreground AGY turn at a time.
- AGY remains an agent execution environment, not a sandboxed inference-only backend.

## Documentation

`DOCUMENTATION.md` is the canonical architectural source of truth for the project.
It tracks:
- architecture;
- verified behavior;
- design decisions;
- operational invariants;
- compatibility;
- testing;
- roadmap;
- known limitations.

Contributors and coding agents should update it in place instead of accumulating duplicate phase reports.

## License

MIT License. See [LICENSE](LICENSE) for details.
The upstream dependency retains its own license and copyright terms.

## Disclaimer

This is an independent companion project built around Google Antigravity / AGY and refined-antigravity-acp.
It is not an official OpenAI or Google product.

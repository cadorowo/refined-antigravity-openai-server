# Live comparison — 29 September 2026

Three sequential runs on this host used the same request: `Reply with exactly AGY_BENCH_OK. Do not use tools.` All nine turns succeeded and returned the marker. The server and direct ACP used the single configured profile, ACP model `gemini-3.7-flash`, and low thought level. The CLI used its own cached credentials and `gemini-3.7-flash-low` model. The reproducible script is `bin/compare-live.mjs`; the latest machine-readable run is `live-comparison.json`.

| Path | Run 1 | Run 2 | Run 3 | Median | Measurement |
| --- | ---: | ---: | ---: | ---: | --- |
| OpenAI HTTP server startup | 2.699 s | 2.725 s | 2.700 s | 2.700 s | ACP profile initialization and HTTP listen |
| OpenAI HTTP server turn | 8.798 s | 5.546 s | 5.554 s | 5.554 s | Full HTTP request and response, after startup |
| Direct refined ACP startup | 2.712 s | 2.698 s | 2.888 s | 2.712 s | ACP profile initialization |
| Direct refined ACP turn | 4.579 s | 4.679 s | 6.506 s | 4.679 s | Session creation, configuration, prompt, and result |
| `agy` CLI total | 6.618 s | 5.264 s | 6.417 s | 6.417 s | Process launch through JSON result |

These are three end-to-end observations, not a controlled throughput benchmark. The model's generation time varied by several seconds, and the CLI has a different session and credential stack. Token usage was around 13.9k input tokens for ACP/server and 13.5k for CLI, so token figures are not directly comparable. The measured skip of redundant ACP config requests is a code-path optimization; these samples do not isolate its latency effect.

## Practical comparison

| Interface | Best fit | What it adds | Main limit |
| --- | --- | --- | --- |
| This OpenAI server | Existing OpenAI SDK clients and HTTP services | Chat Completions, Responses, SSE, model discovery, token usage, multi-profile routing, health checks | Additional HTTP and routing work; one foreground turn per profile; no OpenAI tool calling or multimodal input |
| [Refined Antigravity ACP](https://github.com/simonepri/refined-antigravity-acp) | ACP editors and custom ACP clients | Direct ACP session and tool protocol with upstream hardening | Client must implement ACP; no OpenAI HTTP API or multi-account router by itself |
| [`agy` CLI](https://antigravity.google/docs/cli/headless/) | Human terminal use and scripts | Built-in agent UI, headless JSON/NDJSON output, CLI conversation continuation | CLI-specific interface; each `--print` invocation includes process startup |

The HTTP server wraps refined ACP, so it inherits upstream behavior and adds a compatibility layer. Choose direct ACP when the client already speaks ACP; choose the server when an OpenAI-compatible API or profile pool is needed; choose `agy` for native terminal agent workflows.

## Validation

- Initial working tree: 177/183 tests passed consistently; unknown model IDs were silently mapped to another model. One shutdown timing test failed on the first run and passed on repeat.
- Final working tree: 184/184 tests passed, including a new stale-model failover case.
- Mock concurrency and stress suite passed: two simultaneous turns on two profiles, 503 on a third concurrent request, mixed SSE, and sequential soak.
- Live HTTP Chat Completions, direct ACP, and CLI turns each succeeded in all three comparison runs.
- Final live Responses and Chat Completions streaming smoke both passed using the official OpenAI Node SDK against an isolated server instance.
- Docker image build and Compose validation passed. Compose rejects a missing API key.

The currently running Docker container was not restarted during validation. The code and newly built image contain the changes; a future deployment must set a real `REFINED_AGY_API_KEY`.

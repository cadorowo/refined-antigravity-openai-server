# Phase 1 — Headless ACP transport probe

This spike answers one architectural question before adding the OpenAI-compatible HTTP server:

> When `@simonepri/refined-antigravity-acp` is used without an editor on the other side, which ACP client-side methods does `agy_acp_server` actually require for a normal coding turn?

Unlike the first prototype, this probe lives in a **separate companion repository**. It imports the upstream package only through `src/upstream/refined-antigravity.ts`; no files in `refined-antigravity-acp` need to be patched.

## What it does

1. Creates an isolated temporary workspace.
2. Writes `probe-input.txt` with a known marker.
3. Starts the upstream public `createAntigravityConnector()` through our adapter.
4. Sends ACP `initialize` with protocol version 1.
5. Sends `session/new` with the isolated workspace as `cwd`.
6. Optionally applies `model` and `reasoning_effort` through `session/set_config_option`.
7. Sends a deliberately tool-oriented but benign prompt: read one file, write one file, and, if a shell is normally available, run only `pwd`.
8. Records every ACP message in both directions.
9. Detects agent→client JSON-RPC requests, including `session/request_permission`, `fs/*`, `terminal/*`, and unknown extension methods.
10. Writes a JSON report with the raw wire trace and a derived assessment.

The probe intentionally does **not** implement `fs/*` or `terminal/*`. If AGY requests them, it records the request and returns JSON-RPC `-32601`. That is the signal we need before designing the HTTP client host.

## Run

Install and verify the companion repo:

```bash
pnpm install
pnpm check
```

Run the safe/default probe first:

```bash
pnpm probe:headless -- --permission-policy reject
```

Then run the decisive server-side tool test:

```bash
pnpm probe:headless -- --permission-policy allow-once
```

`allow-once` grants a model-requested permission only when AGY offers an `allow_once` option. The prompt is constrained to the temporary probe workspace and requests only `pwd` as a shell command, but the permission is still real and should be used intentionally.

To test how advertised client capabilities change behavior:

```bash
pnpm probe:headless -- --advertise-client-tools --permission-policy reject
```

Optional model and reasoning configuration:

```bash
pnpm probe:headless -- --model '<model-id>' --effort medium
```

Custom report path:

```bash
pnpm probe:headless -- --report ./tmp/headless-report.json
```

Default report path:

```text
./headless-acp-probe-report.json
```

## Decision table

| Observation | Consequence for the OpenAI server |
| --- | --- |
| Output file is written, no `fs/*` or `terminal/*` request | Keep the HTTP layer thin; AGY/localharness owns coding tools. |
| Only `session/request_permission` appears | Add a permission policy to the in-process ACP runtime; no fs/terminal host yet. |
| `fs/*` appears | Implement a workspace-confined filesystem client host before HTTP support is complete. |
| `terminal/*` appears | Implement a sandboxed terminal host/lifecycle before remote HTTP exposure. |
| Another request method appears | Handle or reject it explicitly; never silently swallow it. |

Important report fields:

- `observedClientMethods`
- `assessment.permissionRequestsObserved`
- `assessment.clientFsRequestsObserved`
- `assessment.clientTerminalRequestsObserved`
- `assessment.serverSideWriteObserved`
- `wire`

Do not move to the HTTP adapter on assumptions. Run at least the `reject` and `allow-once` probes on the actual machine that will host the server.

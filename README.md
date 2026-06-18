# @dymoo/fusion

**A local fusion model provider.** It serves **OpenAI-compatible** and **Anthropic-compatible** HTTP endpoints, then routes each request to either a **single** upstream model or a **panel** of models whose answers an orchestrator/judge model fuses into one. Point Claude Code, opencode, or any OpenAI/Anthropic client at it.

- One endpoint in front of your ChatGPT/Codex subscription, local Ollama, and any OpenAI-compatible API.
- **Round-robin** load spreading across an orchestrator pool and a panel pool, with **graceful failover** on rate limits and errors.
- **Capability negotiation**: only the least-capable intersection is exposed, `max_tokens` is clamped to the smallest model's limit, and images route only to vision-capable models.
- **Token-caching discipline** (Anthropic `cache_control` breakpoints, OpenAI/Codex prompt-cache keys) to control cost.
- Cross-platform **background daemon** (macOS, Windows, Linux). No native dependencies.

> Fusion is **not an agent.** It never runs shell commands, reads files, or executes tools. It returns model text and tool-call _suggestions_ only — your coding agent stays in control of tool execution.

---

## Table of contents

- [Quick start](#quick-start)
- [How routing works](#how-routing-works)
- [Configure upstreams](#configure-upstreams)
- [Run as a daemon](#run-as-a-daemon)
- [Point a coding agent at it](#point-a-coding-agent-at-it)
- [OpenAI Codex / ChatGPT auth](#openai-codex--chatgpt-auth)
- [Example requests](#example-requests)
- [Capabilities & limits](#capabilities--limits)
- [Token caching](#token-caching)
- [Configuration reference](#configuration-reference)
- [v0 limitations](#v0-limitations)
- [Run the tests](#run-the-tests)
- [For AI agents](#for-ai-agents)
- [License](#license)

---

## Quick start

Requires **Node.js ≥ 22**.

```bash
# 1. Install (global, or use npx)
npm install -g @dymoo/fusion        # or: pnpm add -g @dymoo/fusion

# 2. Create a config
curl -fsSL https://raw.githubusercontent.com/dymoo/fusion/main/config.example.yaml -o config.yaml
#   …or, from a clone:  cp config.example.yaml config.yaml
$EDITOR config.yaml

# 3. (If using your ChatGPT/Codex subscription) sign in once
fusion auth login                    # or reuse an existing `codex` CLI login

# 4. Start the background daemon
fusion start                         # reads ./config.yaml, listens on :8787

# 5. Verify
curl -s http://localhost:8787/health | jq
curl -s http://localhost:8787/v1/models | jq
```

Run it in the foreground instead (useful for debugging): `fusion run`.

---

## How routing works

Every request resolves to one of two modes:

**Single** (default). The request goes to one upstream chosen **round-robin** from the `orchestrator` pool. If that upstream is rate-limited or errors, Fusion **fails over** to the next one in the ring (honoring `Retry-After`, with a per-upstream circuit breaker). The client never sees the failure unless _every_ upstream is exhausted.

**Panel** (escalated). The request fans out in parallel to the members of a named panel (the "models that give opinions"). Their answers are collected, and an **orchestrator/judge** model — selected round-robin from the `orchestrator` pool — synthesizes a single best answer. Only the judge's synthesis is streamed back.

```
                       ┌─ single ─▶ orchestrator ring ─▶ [model A] ──(429)──▶ [model B] ✓
client ─▶ router ──────┤
                       └─ panel ──▶ panel ring ─▶ [A] [B] [C]  ──▶  judge (orchestrator ring) ─▶ answer
```

**When does it escalate to panel?** Fusion defaults to single and escalates only with a reason: a large prompt (`minPromptTokens`), a trigger keyword (`compare`, `design`, `debug`, …), or an explicit override. Tool-bearing (agentic) requests stay single by default.

**Override the route per request:**

- OpenAI body: `"extra_body": {"fusion_route": "panel", "panel": "default"}` (or `"single"`).
- Header (any surface): `x-fusion-route: panel` and `x-fusion-panel: default`.

Every response carries a debug header showing what happened:

```
x-fusion-route: mode=panel; served_by=codex; panel=codex+local+openrouter; reason=escalated:_keyword_"design"
```

A recursion guard (`x-fusion-depth`) prevents a Fusion instance pointed at another Fusion from re-triggering a panel.

---

## Configure upstreams

Upstreams live in `config.yaml`. Each has a `type`:

| type                | wire protocol                      | auth                                    | capability discovery               |
| ------------------- | ---------------------------------- | --------------------------------------- | ---------------------------------- |
| `codex`             | OpenAI Responses (ChatGPT backend) | reuses `~/.codex` / `fusion auth login` | `~/.codex/models_cache.json`       |
| `openai`            | OpenAI Chat Completions            | `apiKey` / `apiKeyEnv`                  | `GET /v1/models`                   |
| `openai-compatible` | OpenAI Chat Completions            | `apiKey` / `apiKeyEnv`                  | `GET /v1/models` + models.dev      |
| `anthropic`         | Anthropic Messages                 | `apiKey` / `apiKeyEnv`                  | `GET /v1/models` + models.dev      |
| `ollama`            | OpenAI Chat Completions at `/v1`   | none (local)                            | `GET /api/tags` + `POST /api/show` |

```yaml
upstreams:
  - id: codex
    type: codex
    models: ["gpt-5.5"] # current OpenAI SOTA; omit to expose all codex models

  - id: ollama
    type: ollama
    baseURL: http://localhost:11434/v1
    # models omitted → auto-discovered

  - id: openrouter
    type: openai-compatible
    baseURL: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    models: ["anthropic/claude-sonnet-4.5"]

pools:
  orchestrator: [codex, openrouter] # single-route + judge ring
  panel:
    default: [codex, openrouter, ollama] # opinion-givers for panel mode
```

Put secrets in environment variables (`apiKeyEnv`), not in the file. `config.yaml` is git-ignored by default.

---

## Run as a daemon

```bash
fusion start [--port N] [--config FILE] [--host H]   # spawn detached, log to ~/.fusion/fusion.log
fusion status                                        # pid + /health probe
fusion logs [--lines N] [--follow]                   # tail the log
fusion restart
fusion stop
fusion run [--port N] [--config FILE]                # foreground (Ctrl-C to stop)
```

State lives in `~/.fusion/` (override with `FUSION_HOME`): `fusion.pid`, `fusion.port`, `fusion.log`, `fusion.err.log`. The daemon is a plain detached Node process — it works identically on macOS, Linux, and Windows with no native daemonizer. `fusion stop` uses `SIGTERM` then `taskkill /T /F` (Windows) / `SIGKILL` (POSIX) as a fallback.

### Run it under your OS service manager (optional)

All three just wrap `fusion run`:

- **Linux (systemd user unit)** — `~/.config/systemd/user/fusion.service`:
  ```ini
  [Service]
  ExecStart=%h/.local/share/pnpm/fusion run --config %h/.config/fusion/config.yaml
  Restart=on-failure
  [Install]
  WantedBy=default.target
  ```
  `systemctl --user enable --now fusion`
- **macOS (launchd)** — a `~/Library/LaunchAgents/app.dymoo.fusion.plist` whose `ProgramArguments` are `[node, /path/to/fusion, run]`.
- **Windows** — wrap `fusion run` with [NSSM](https://nssm.cc/) or Task Scheduler ("At log on").

---

## Point a coding agent at it

### Claude Code

Claude Code speaks the Anthropic Messages format, so point it at Fusion's Anthropic surface:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_AUTH_TOKEN=test            # only needed if you set server.authKey
export ANTHROPIC_MODEL=claude-fusion        # map the default model to a Fusion model
# optional: surface Fusion models in the /model picker
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

> Claude Code's gateway model discovery only lists models whose id starts with `claude`/`anthropic`. Fusion advertises a `claude-fusion` alias for exactly this reason — use it (or set `ANTHROPIC_MODEL`).

### opencode

Add an OpenAI-compatible provider to `opencode.json` (project) or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "fusion": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Fusion",
      "options": { "baseURL": "http://localhost:8787/v1", "apiKey": "test" },
      "models": { "fusion/coder": { "name": "Fusion Coder" } }
    }
  },
  "model": "fusion/fusion/coder"
}
```

### Any OpenAI client

```
Base URL: http://localhost:8787/v1
API key:  test            (any value, unless server.authKey is set)
Model:    fusion/coder
```

---

## OpenAI Codex / ChatGPT auth

Fusion can use your ChatGPT/Codex subscription with **no API key**:

- **Reuse the `codex` CLI login** — if you already ran `codex login`, Fusion reads `~/.codex/auth.json` (override the dir with `CODEX_HOME`). It refreshes and rotates the token automatically and writes it back in codex's own format, so both tools keep working.
- **`fusion auth login`** — runs the same OAuth (PKCE) loopback flow as codex on machines without the codex CLI, and saves credentials to `~/.codex/auth.json`.

If a refresh is rejected (`invalid_grant`), re-run `fusion auth login`. Tokens are never logged.

---

## Example requests

```bash
# Health & model list
curl -s http://localhost:8787/health | jq
curl -s http://localhost:8787/v1/models | jq

# Single route (simple prompt)
curl -s http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"fusion/coder","messages":[{"role":"user","content":"Say hello in one sentence."}],"temperature":0.2}' | jq

# Panel route (hard prompt escalates) — inspect the x-fusion-route header
curl -si http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"fusion/coder","messages":[{"role":"user","content":"I have a FastAPI service with intermittent deadlocks under load (async SQLAlchemy + Postgres). Give me a debugging plan, likely root causes, and code-level fixes."}]}' \
  | grep -i x-fusion-route

# Streaming
curl -N http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"fusion/coder","stream":true,"messages":[{"role":"user","content":"Stream a haiku."}]}'

# Anthropic surface (what Claude Code uses)
curl -s http://localhost:8787/v1/messages \
  -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-fusion","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}' | jq

# Force a panel via header
curl -si http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-fusion-route: panel' \
  -d '{"model":"fusion/coder","messages":[{"role":"user","content":"Design a rate limiter."}]}' | grep -i x-fusion-route
```

---

## Capabilities & limits

Fusion queries each upstream's capabilities (vision, tools, context window, max output) at startup and on an interval, from provider-native sources (Ollama `/api/show`, codex models cache, `/v1/models`), a bundled models.dev registry, and your config overrides.

It then exposes the **least-capable intersection** across a route so a client never asks for something the weakest member cannot do:

- **tools** are advertised only if _every_ model in the route supports them;
- **modalities** are the set intersection;
- **context window** and **max output** are the minimum across the route.

`max_tokens` is clamped to the smallest model's output limit. If a request contains an **image**, Fusion routes only to **vision-capable** models; if none are available it returns a clear error (or strips images, per `routing.imageFallback`).

---

## Token caching

To control cost and usage allowances:

- **Anthropic upstreams** get `cache_control` breakpoints injected on the stable prefix (tools + last system block, 1-hour TTL) and the last messages (5-minute TTL), capped at 4 breakpoints — so repeated turns read the cache at a fraction of the cost.
- **OpenAI / Codex upstreams** get a stable `prompt_cache_key` per session (and Codex requests set `store: false`).
- Optional **session affinity** (`caching.sessionAffinity.enabled`) pins a session to its last upstream to maximize cache reads; it coexists with round-robin (it only changes where failover starts, never removes a ring member).

---

## Configuration reference

See [`config.example.yaml`](./config.example.yaml) for a fully commented example. Top-level keys:

| key            | purpose                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server`       | `host`, `port`, optional `authKey`                                                                                                                                                                     |
| `upstreams[]`  | `id`, `type`, `baseURL?`, `apiKey?`/`apiKeyEnv?`, `models?`, `reasoningEffort?` (codex→`reasoning.effort` e.g. `xhigh`; OpenAI-compat→`reasoning_effort`), `capabilityOverrides?`, `requestTimeoutMs?` |
| `pools`        | `orchestrator: [ids]`, `panel: { name: [ids] }`                                                                                                                                                        |
| `routing`      | `defaultMode`, `defaultPanel`, `forceSingleWhenTools`, `imageFallback`, `escalation{…}`                                                                                                                |
| `caching`      | `anthropic{enabled,maxBreakpoints,oneHour}`, `promptCacheKey{enabled}`, `sessionAffinity{enabled}`                                                                                                     |
| `capabilities` | `refreshIntervalSec`                                                                                                                                                                                   |

Environment overrides: `FUSION_PORT`, `FUSION_HOST`, `FUSION_AUTH_KEY`, `FUSION_CONFIG`, `FUSION_HOME`, `CODEX_HOME`, `FUSION_LOG_LEVEL`.

---

## v0 limitations

- **No panel tool-call aggregation.** In panel mode the judge owns the final tool calls; members' tool calls are flattened into the judge prompt as text. Agentic/tool-bearing sessions default to single mode.
- **No config hot-reload.** Edit `config.yaml`, then `fusion restart`.
- **No cost optimiser / eval harness** yet.
- **Model auto-discovery** is limited to provider-native sources + a bundled models.dev snapshot.
- **Panel latency**: panel members run non-streaming and are buffered before the judge streams; the first token appears only once the judge starts.

---

## Run the tests

```bash
pnpm install
pnpm test          # builds, then runs node --test
pnpm run check-all # prettier --check + eslint + tsc --noEmit
```

---

## For AI agents

Machine-readable setup:

```yaml
provider: openai-compatible # also exposes an anthropic-compatible surface
base_url: http://localhost:8787/v1 # Anthropic clients: http://localhost:8787
api_key: test # any value unless server.authKey is set
models: [fusion/coder, fusion/panel, claude-fusion]
openai_endpoints: [GET /v1/models, POST /v1/chat/completions]
anthropic_endpoints: [POST /v1/messages, POST /v1/messages/count_tokens, GET /v1/models]
route_override:
  body: { extra_body: { fusion_route: "single|panel", panel: "<name>" } }
  header: { x-fusion-route: "single|panel", x-fusion-panel: "<name>" }
debug_header: x-fusion-route # on every response: mode, served_by, panel, reason
streaming: supported # single route + panel judge synthesis
```

To install and run autonomously: `npm i -g @dymoo/fusion`, write a `config.yaml` (copy `config.example.yaml`), then `fusion start`. Probe `GET /health` for readiness; it returns the configured upstreams, pools, and the exposed capability floor.

---

## License

MIT © dymoo

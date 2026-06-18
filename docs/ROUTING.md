# Routing

Fusion turns one virtual model (`fusion`) into a router over your configured upstreams. Set the strategy with `routing.mode`:

| mode              | behaviour                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `single`          | Always one model — round-robin over `pools.orchestrator` with graceful failover.                        |
| `smart` (default) | A local code-embedding model classifies each request into a complexity **tier** and routes accordingly. |
| `all`             | Always fuse — fan out to the whole panel and aggregate with a judge (OpenRouter-Fusion style).          |

You can override per request:

- OpenAI body (`extra_body`): `{ "fusion_route": "single|smart|all|compact|regular|plan", "panel": "<name>" }` or `{ "fusion_tier": "compact|regular|plan" }`.
- Headers (any surface): `x-fusion-route: single|smart|all|compact|regular|plan`, `x-fusion-tier: …`, `x-fusion-panel: …`.

Every response carries an `x-fusion-route` debug header, e.g.:

```
x-fusion-route: mode=single; tier=regular; served_by=kimi; scores=compact:0.19,regular:0.41,plan:0.27; reason=smart[embedding]:_latest+system_→_regular=0.41
```

---

## Smart mode

`smart` maps a complexity **tier** to a routing strategy:

| tier      | meaning                                  | strategy                | pool                                                    |
| --------- | ---------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `compact` | trivial (typo, rename, "what does X do") | single                  | `pools.compact` (defaults to `[orchestrator[0]]`)       |
| `regular` | normal code work (implement, test, fix)  | single, round-robin     | `pools.regular` (defaults to first 2 of `orchestrator`) |
| `plan`    | architecture / planning / big refactor   | **all** (panel + judge) | `pools.panel[defaultPanel]`                             |

So trivial edits hit one fast model, normal work round-robins a small set, and genuine planning fans out to everyone.

### How the classifier works

The classifier is **embedding-only** — there is no token-count or keyword heuristic that can quietly bypass it (see _No silent fallbacks_ below). For each request:

1. **Assemble salient segments.** Embedding only the last message is too coarse for agentic multi-turn sessions, where the tail is often `"yes, do that"` / `"now fix the test"` while the real complexity lives earlier. So Fusion extracts a small, bounded set of segments:
   - `latest` — the last user message,
   - `recent` — the previous 1–2 user turns (recovers intent when the tail is terse),
   - `tool` — current-turn tool-result text (e.g. a failing test → debugging),
   - `code` — the largest fenced code block in the latest/tool content,
   - `system` — a bounded prefix of the system prompt.
2. **Embed all segments in one batch** with a local ONNX code-embedding model.
3. **Harness-mode detection (semantic).** Coding agents inject distinctive _plan mode_ and _/compact_ instructions. Fusion matches the segments against the real harness prompts (Claude Code, opencode, Cline, Aider) as embedding anchors — **not** substring matching. If any segment is ≥ `harnessConfidence` (0.5) cosine to the plan-mode anchors → force `plan`; to the compaction anchors → force `compact`. This is why a session that is _actually in plan mode_ fans out, while the mere word "plan" in a normal system prompt does nothing.
4. **Tier classification (max-pool).** For each tier, take the **max cosine across segments** to that tier's anchor centroid, then argmax. Max-pool answers "is _any_ salient part of this a planning task", so a terse final line can't down-tier genuinely hard work and a long history can't average the signal away.

Results are cached per turn (hash of the assembled segments).

### The embedding model

- In-process via [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (ONNX) — **no external service**.
- Default: **`jinaai/jina-embeddings-v2-base-code`** (code-trained, 768-dim, 8192-token context) at `dtype: q8` (~100–160 MB, downloaded once to the HF cache on first run).
- **GPU if available:** loaded with `device: "auto"`, which uses the best execution provider (GPU / Apple CoreML / CUDA) and transparently falls back to multi-threaded CPU.
- Configurable: `routing.smart.embeddings.{model,dtype}` or env `FUSION_EMBED_MODEL`, `FUSION_EMBED_DTYPE`, `FUSION_EMBED_DEVICE`, `FUSION_EMBED_CACHE`. A lighter non-code alternative: `Xenova/all-MiniLM-L6-v2` (q8, 23 MB).

### No silent fallbacks (repo-wide rule)

The embedding classifier is the core of smart routing, so it never silently degrades to a non-embedding path:

- If the model **can't load**, `smart` requests return **HTTP 503** with a clear message, and `GET /health` reports `classifier: { ready: false, error: "…" }`. Switch `routing.mode` to `single`/`all`, or fix `FUSION_EMBED_MODEL`.
- There are **no token guards** — a short but complex `"design the architecture for X"` is classified by meaning, not down-tiered by length.

### Tool / agentic turns (and why they never panel)

**A request carrying `tools` is never routed to the panel.** The panel fans out non-streaming and synthesizes one answer with a judge — it is **text-only** and cannot merge heterogeneous tool calls. If a tool-bearing request reached it, the client would get prose with no `tool_use` block, which **stalls a coding agent's loop** (it has nothing to execute and just stops). This invariant is enforced unconditionally, _after_ routing is decided, so it also covers `x-fusion-route: all`, `x-fusion-tier: plan`, and `mode: all`: any of those carrying tools degrades to `single` over the **actor** ring (logged as a `warn`, and visible in the `x-fusion-route` reason). The classified tier is still reported in the header.

`routing.forceSingleWhenTools` (default `true`) is the _upstream_ knob: when `true`, tool-bearing requests skip the tier classifier for pool selection and go straight to the **actor** pool — cheap, deterministic, and the right default since coding agents (Claude Code, opencode) send their toolset every turn. Set it to **`false`** to let the smart classifier pick `compact`/`regular` pools for tool turns too — but `plan`-tier tool turns still degrade to the actor, never the panel.

So in practice: agentic coding is always served by **one** model per turn. Two things make that single model count: it's the **actor** pool (your strongest reasoner), and on hard turns a **council** advises it (below).

### The actor pool

`pools.actor` is the single-route ring that drives agentic/tool turns. Point it at your strongest tool-capable reasoner (e.g. `codex` `gpt-5.5` at `reasoningEffort: xhigh`). It defaults to the orchestrator members if unset. Combined with session affinity, a coding session round-robins its starting actor then **pins to it** — so each session is coherent and strong, while load still spreads across sessions.

### Council-then-act (multi-model reasoning on tool turns)

The plain panel can't drive tools, so fusing every agentic turn isn't possible. **Council-then-act** is the tool-compatible version of mixture-of-agents:

1. **Gate.** On a tool turn, the classifier runs; the council convenes only when the tier meets `council.trigger` (default `plan`; `always` = every agentic turn). Routine turns skip it and just run the actor — fast. If the classifier is unavailable, the turn proceeds **actor-only** (logged, never silent — the agent must keep working).
2. **Deliberate.** The `council.panel` advisors run in parallel and **reason as text** about the next step (their proposed tool calls are captured as advice, but they never execute). The session's actor model is auto-excluded from the advisors (`council.excludeActor`) for diversity.
3. **Synthesize** (optional, `council.synthesize`). A judge condenses the advisors into one short briefing (recommended action · considerations · disagreements). Otherwise the raw labelled opinions are used.
4. **Act.** The **actor** runs with the **real tools** and the briefing injected as an extra `system` part (the conversation is untouched). It emits real `tool_use` → the agent loop continues, now informed by the whole council.

In short: **codex drives; glm/kimi/minimax counsel when it's hard.** This is where the other models earn their keep on agentic work. It costs N advisor calls (+1 judge) per hard turn — fine when compute is cheap, and gated to the turns that benefit. The `x-fusion-route` header shows `actor=…; council=…` when it ran.

The plain **panel** (`mode: all`, or the smart `plan` tier on a **tool-free** request) is unchanged — that's the right place for one-shot deliberation (research, "compare and contrast", design questions).

### Multi-turn / agentic coding

Long agentic sessions (Claude Code running for many turns) need continuity: a follow-up `tool_result` should go back to the model that emitted the `tool_use`, and prompt-cache reads only help if turns hit the same upstream. Enable it:

```yaml
caching:
  sessionAffinity: { enabled: true }
```

With affinity on, the first turn picks a model round-robin from the orchestrator ring and **pins the session to it** (keyed off the client's session id — Claude Code sends `x-claude-code-session-id`; otherwise a hash of the stable conversation prefix). Subsequent turns stay on that model; if its circuit breaker opens, failover re-pins to a healthy one. Load still spreads _across_ sessions (each new session round-robins its starting model), while each individual session stays coherent. The pin map is bounded, so a long-running daemon can't leak memory.

---

## Single & all modes

- **`single`** round-robins `pools.orchestrator` and fails over (429 / 5xx / timeout / 401-403-404 → next upstream, honoring `Retry-After`, with a per-upstream circuit breaker). Only a fully-exhausted ring surfaces an error.
- **`all`** fans out to `pools.panel[defaultPanel]` in parallel (non-streaming), then a judge — selected round-robin from `pools.orchestrator` — synthesizes one answer (the judge's output is what streams to the client). Recursion is guarded via `x-fusion-depth`. **The panel is text-only**: a request carrying `tools` degrades to `single` (see _Tool / agentic turns_ above), so `all` only fuses tool-free requests.

## Configuration

See [`config.example.yaml`](../config.example.yaml). Routing keys:

```yaml
pools:
  orchestrator: [codex, glm, kimi, minimax] # judge ring + default single
  compact: [glm] # smart compact tier (optional)
  regular: [glm, kimi] # smart regular tier (optional)
  actor: [codex] # agentic/tool turns drive through this (strong tool-driver)
  panel:
    default: [codex, glm, kimi, minimax]
    council: [glm, kimi, minimax] # council advisors (exclude the actor)

routing:
  mode: smart # single | smart | all
  defaultPanel: default
  forceSingleWhenTools: true # tool turns → actor pool (recommended for agents)
  imageFallback: error # error | strip (no vision model for an image request)
  smart:
    embeddings: { model: jinaai/jina-embeddings-v2-base-code, dtype: q8 }
    tiers: { compact: { pool: compact }, regular: { pool: regular }, plan: { panel: default } }
    thresholds: { harnessConfidence: 0.5 }
    fallbackTier: regular # only for a genuinely empty request
  council: # council-then-act on hard agentic turns
    enabled: true
    panel: council # advisors that deliberate (text-only); actor auto-excluded
    trigger: plan # compact | regular | plan | always
    synthesize: true # judge condenses advisors into one briefing

caching:
  sessionAffinity: { enabled: true } # pin agentic sessions to one model (coherent multi-turn)
```

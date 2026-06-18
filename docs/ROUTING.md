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

### Tool / agentic turns

`routing.forceSingleWhenTools` (default `true`) forces tool-bearing requests to `single`. Coding agents (Claude Code, opencode) send their toolset every turn, so with the default they get reliable single-model routing.

Set it to **`false`** to let the smart classifier drive agentic turns too — trivial edits → `compact`, normal work → `regular`, and _plan-mode_ / design turns → the panel. Note the v0 limitation: in panel mode the **judge** owns the final tool calls; panel members' tool calls are not merged.

---

## Single & all modes

- **`single`** round-robins `pools.orchestrator` and fails over (429 / 5xx / timeout / 401-403-404 → next upstream, honoring `Retry-After`, with a per-upstream circuit breaker). Only a fully-exhausted ring surfaces an error.
- **`all`** fans out to `pools.panel[defaultPanel]` in parallel (non-streaming), then a judge — selected round-robin from `pools.orchestrator` — synthesizes one answer (the judge's output is what streams to the client). Recursion is guarded via `x-fusion-depth`.

## Configuration

See [`config.example.yaml`](../config.example.yaml). Routing keys:

```yaml
pools:
  orchestrator: [codex, glm, kimi, minimax] # judge ring + default single
  compact: [glm] # smart compact tier (optional)
  regular: [glm, kimi] # smart regular tier (optional)
  panel: { default: [codex, glm, kimi, minimax] }

routing:
  mode: smart # single | smart | all
  defaultPanel: default
  forceSingleWhenTools: false # true keeps agentic/tool turns single
  imageFallback: error # error | strip (no vision model for an image request)
  smart:
    embeddings: { model: jinaai/jina-embeddings-v2-base-code, dtype: q8 }
    tiers: { compact: { pool: compact }, regular: { pool: regular }, plan: { panel: default } }
    thresholds: { harnessConfidence: 0.5 }
    fallbackTier: regular # only for a genuinely empty request
```

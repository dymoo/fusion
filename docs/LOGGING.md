# Logging

Fusion logs the full lifecycle of every request as structured JSON (one object per line) so you can see exactly what it's doing internally. Each request gets a child logger bound to `reqId`, `sessionId`, and `surface` (`openai` | `anthropic`) for easy correlation.

## Levels

Set `FUSION_LOG_LEVEL` to `debug | info | warn | error` (default `info`).

- **info** (default) shows the whole routing lifecycle — enough to "see everything going on".
- **debug** adds the granular detail (per-tier cosine scores, cache hits, embedder load/warmup timings, per-upstream attempt latencies).
- `warn`/`error` go to **stderr** (→ `~/.fusion/fusion.err.log`); `debug`/`info` go to **stdout** (→ `~/.fusion/fusion.log`).

Secrets (`authorization`, `x-api-key`, `access_token`, `refresh_token`, `id_token`, …) are always redacted.

## What gets logged (per request)

At **info**:

| msg                                                                      | fields                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `request`                                                                | `model, stream, messages, tools, images, depth, override`   |
| `classified request`                                                     | `tier, source, tokenEstimate, scores, ms` (smart mode)      |
| `route`                                                                  | `strategy, pool/panel, tier, members, reason`               |
| `panel fan-out` / `panel member ok` / `panel judging` / `panel complete` | `members, judge, per-member ms + outputTokens`              |
| `served`                                                                 | `servedBy, stream, inputTokens, outputTokens, finishReason` |
| `response done`                                                          | `stream, totalMs`                                           |
| `upstream failed, advancing ring`                                        | `upstream, status, ms, error` (failover)                    |

At **debug**: `classified` (full per-tier `scores` + `reason`), `classify cache hit`, `embedder loaded` (`model, dtype, device, ms`), `smart classifier ready`, `upstream attempt ok` (`upstream, ms`).

`source` on a classification is one of: `embedding` (tier max-pool), `harness` (plan-mode / compaction detected), `cache`, or `fallback` (empty request only).

## Watching the logs

```bash
fusion logs                 # last 50 lines
fusion logs --lines 200
fusion logs --follow        # stream (Ctrl-C to stop)

# pretty-print with jq:
fusion logs --follow | jq -c '{t:.ts,msg,tier,source,strategy,servedBy,reason}'
```

Run in the foreground to watch live with full detail:

```bash
FUSION_LOG_LEVEL=debug fusion run
```

## Health

`GET /health` reports liveness and, in `smart` mode, the classifier status:

```json
{
  "status": "ok",
  "mode": "smart",
  "upstreams": ["codex", "glm", "kimi", "minimax"],
  "orchestrator": ["codex", "glm", "kimi", "minimax"],
  "panels": ["default"],
  "classifier": {
    "ready": true,
    "embedder": "transformers:jinaai/jina-embeddings-v2-base-code:q8:auto",
    "error": null
  },
  "floor": {
    "tools": true,
    "modalities": ["text"],
    "contextWindow": 262144,
    "maxOutputTokens": 32768
  }
}
```

If the embedding model failed to load, `classifier.ready` is `false` and `classifier.error` explains why (and smart requests return HTTP 503 — never a silent non-embedding fallback).

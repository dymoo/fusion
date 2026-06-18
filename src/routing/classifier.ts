import type { SmartRoutingConfig } from "../config/schema.js";
import type { Embedder } from "../embeddings/embedder.js";
import { cosine, meanNormalize } from "../embeddings/vector.js";
import { flattenText, type NeutralRequest } from "../neutral/types.js";
import { shortHash } from "../util/id.js";
import { type Logger, logger } from "../util/logger.js";
import { DEFAULT_ANCHORS, HARNESS_ANCHORS, type Tier, TIERS } from "./anchors.js";
import { estimateTokens } from "./router.js";

export type ClassSource = "embedding" | "harness" | "fallback" | "cache";

export interface ClassResult {
  tier: Tier;
  scores: Record<Tier, number>;
  tokenEstimate: number;
  source: ClassSource;
  reason: string;
}

interface Segment {
  tag: string;
  text: string;
}

/**
 * Thrown when smart routing is requested but the embedding model is unavailable.
 * Per the repo-wide rule, the classifier never silently degrades to a non-embedding
 * path — embeddings are the core feature, so a failure is surfaced loudly.
 */
export class ClassifierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierUnavailableError";
  }
}

const ZERO_SCORES: Record<Tier, number> = { compact: 0, regular: 0, plan: 0 };

/** Return the content of the longest fenced ``` code block, or "". */
function largestCodeBlock(text: string): string {
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let best = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1] ?? "";
    if (body.length > best.length) best = body;
  }
  return best;
}

function maxCosine(vecs: number[][], centroid: number[]): number {
  let best = -Infinity;
  for (const v of vecs) best = Math.max(best, cosine(v, centroid));
  return best;
}

/**
 * Classifies a request into a complexity tier using a local code embedding model.
 * Embeddings are the ONLY classifier — there is no silent token/keyword fallback.
 * Two ideas make it robust for real agentic coding:
 *
 *  1. Multi-segment max-pool. Instead of embedding only the last message (often a
 *     terse "yes, do that"), it assembles salient segments — latest turn, previous
 *     turns, current-turn tool output, the largest pasted code block, and a
 *     system-prompt prefix — and scores each tier by the MAX cosine across
 *     segments. A terse tail can't down-tier genuinely hard work, and a short but
 *     complex "design the architecture" prompt is still classified by meaning.
 *
 *  2. Semantic harness-mode detection. Coding agents inject distinctive "plan
 *     mode" / "/compact" instructions. We match segments against the real harness
 *     prompts as anchors (NOT substring) — so an actual plan-mode turn routes to
 *     `plan` and a compaction turn to `compact`, while the mere word "plan" in a
 *     normal system prompt does nothing.
 *
 * If the embedding model cannot be loaded, classify() throws (loud, not silent).
 */
export class ComplexityClassifier {
  private centroids: Record<Tier, number[]> | null = null;
  private harness: { plan: number[]; compact: number[] } | null = null;
  private initing: Promise<void> | null = null;
  private loadError: string | null = null;
  private readonly cache = new Map<string, ClassResult>();
  private readonly cacheCap = 1000;

  constructor(
    private readonly embedder: Embedder,
    private readonly cfg: SmartRoutingConfig,
  ) {}

  private anchorsFor(tier: Tier): string[] {
    return this.cfg.anchors?.[tier] ?? DEFAULT_ANCHORS[tier];
  }

  /** Warm the model and precompute tier + harness centroids. Memoized. */
  init(): Promise<void> {
    this.initing ??= (async () => {
      const started = Date.now();
      try {
        const centroids: Record<Tier, number[]> = { compact: [], regular: [], plan: [] };
        for (const tier of TIERS) {
          centroids[tier] = meanNormalize(await this.embedder.embed(this.anchorsFor(tier)));
        }
        this.harness = {
          plan: meanNormalize(await this.embedder.embed(HARNESS_ANCHORS.plan)),
          compact: meanNormalize(await this.embedder.embed(HARNESS_ANCHORS.compact)),
        };
        this.centroids = centroids;
        logger.info("smart classifier ready", {
          embedder: this.embedder.id,
          ms: Date.now() - started,
        });
      } catch (err) {
        this.loadError = (err as Error).message;
        logger.error("smart classifier FAILED to load embedding model (smart routing will error)", {
          embedder: this.embedder.id,
          error: this.loadError,
        });
      }
    })();
    return this.initing;
  }

  /** Readiness for /health. */
  ready(): { ready: boolean; embedder: string; error: string | null } {
    return { ready: this.centroids !== null, embedder: this.embedder.id, error: this.loadError };
  }

  /** Assemble bounded, salient segments for classification (latest first). */
  private assembleSegments(req: NeutralRequest): Segment[] {
    const cap = this.cfg.maxTextChars;
    const msgs = req.messages;
    const segs: Segment[] = [];
    const seen = new Set<string>();
    const push = (tag: string, raw: string): void => {
      const text = raw.trim().slice(0, cap);
      if (!text) return;
      const dedupeKey = text.slice(0, 200);
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      segs.push({ tag, text });
    };

    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const latestText = lastUserIdx >= 0 ? flattenText(msgs[lastUserIdx]?.content ?? []) : "";
    if (latestText) push("latest", latestText);

    const prevUsers: string[] = [];
    for (let i = lastUserIdx - 1; i >= 0 && prevUsers.length < 2; i--) {
      if (msgs[i]?.role === "user") prevUsers.push(flattenText(msgs[i]?.content ?? []));
    }
    if (prevUsers.length > 0) push("recent", prevUsers.reverse().join("\n\n"));

    let lastAssistant = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") {
        lastAssistant = i;
        break;
      }
    }
    const toolTexts: string[] = [];
    for (let i = Math.max(0, lastAssistant); i < msgs.length; i++) {
      if (msgs[i]?.role === "tool") toolTexts.push(flattenText(msgs[i]?.content ?? []));
    }
    if (toolTexts.length > 0) push("tool", toolTexts.join("\n\n"));

    const code = largestCodeBlock(`${latestText}\n${toolTexts.join("\n")}`);
    if (code) push("code", code);

    if (req.system && req.system.length > 0) push("system", flattenText(req.system));

    return segs;
  }

  async classify(req: NeutralRequest, log: Logger = logger): Promise<ClassResult> {
    await this.init(); // memoized; waits for model load on first call
    if (this.centroids === null || this.harness === null) {
      throw new ClassifierUnavailableError(
        `smart routing requires the embedding model "${this.embedder.id}", which failed to load` +
          (this.loadError ? `: ${this.loadError}` : "") +
          ". Fix the model (FUSION_EMBED_MODEL) or set routing.mode to single/all.",
      );
    }

    const segments = this.assembleSegments(req);
    const tokenEstimate = estimateTokens(req);
    const key = shortHash(`${tokenEstimate}:${segments.map((s) => `${s.tag}:${s.text}`).join("")}`);

    const cached = this.cache.get(key);
    if (cached) {
      log.debug("classify cache hit", { tier: cached.tier });
      return { ...cached, source: "cache" };
    }

    // Genuinely empty request (nothing to embed) — the one non-embedding outcome.
    if (segments.length === 0) {
      return this.finish(
        key,
        {
          tier: this.cfg.fallbackTier,
          scores: ZERO_SCORES,
          tokenEstimate,
          source: "fallback",
          reason: "empty request",
        },
        log,
      );
    }

    const vecs = await this.embedder.embed(segments.map((s) => s.text));

    // (1) Harness-mode detection (semantic, over the salient segments).
    const planSim = maxCosine(vecs, this.harness.plan);
    const compactSim = maxCosine(vecs, this.harness.compact);
    const thr = this.cfg.thresholds.harnessConfidence;
    if (planSim >= thr && planSim >= compactSim) {
      return this.finish(
        key,
        {
          tier: "plan",
          scores: ZERO_SCORES,
          tokenEstimate,
          source: "harness",
          reason: `plan-mode detected (sim=${planSim.toFixed(3)})`,
        },
        log,
      );
    }
    if (compactSim >= thr) {
      return this.finish(
        key,
        {
          tier: "compact",
          scores: ZERO_SCORES,
          tokenEstimate,
          source: "harness",
          reason: `compaction detected (sim=${compactSim.toFixed(3)})`,
        },
        log,
      );
    }

    // (2) Tier classification: max-pool cosine to each tier centroid, argmax.
    const scores: Record<Tier, number> = { compact: 0, regular: 0, plan: 0 };
    for (const tier of TIERS) scores[tier] = maxCosine(vecs, this.centroids[tier]);
    const top = [...TIERS].sort((a, b) => scores[b] - scores[a])[0] ?? this.cfg.fallbackTier;
    const reason = `${segments.map((s) => s.tag).join("+")} → ${top}=${scores[top].toFixed(3)}`;
    return this.finish(key, { tier: top, scores, tokenEstimate, source: "embedding", reason }, log);
  }

  private finish(key: string, result: ClassResult, log: Logger): ClassResult {
    this.cache.set(key, result);
    if (this.cache.size > this.cacheCap) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    log.debug("classified", {
      tier: result.tier,
      source: result.source,
      tokenEstimate: result.tokenEstimate,
      scores: result.scores,
      reason: result.reason,
    });
    return result;
  }
}

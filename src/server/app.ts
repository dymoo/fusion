import { CapabilityResolver } from "../capabilities/resolver.js";
import type { Capabilities } from "../capabilities/types.js";
import type { FusionConfig } from "../config/schema.js";
import { buildEmbedder } from "../embeddings/factory.js";
import {
  hasImages,
  type NeutralRequest,
  type NeutralResult,
  type StreamEvent,
} from "../neutral/types.js";
import type { Tier } from "../routing/anchors.js";
import { runCouncilThenAct, shouldConvene } from "../panel/council.js";
import { ImageRouteError, runPanel } from "../panel/orchestrator.js";
import { ComplexityClassifier } from "../routing/classifier.js";
import { Executor } from "../routing/failover.js";
import {
  decideStatic,
  disablePanelWhenTools,
  fromTier,
  MAX_DEPTH,
  resolvePanel,
  type RouteDecision,
  type RouteOverride,
} from "../routing/router.js";
import { selectCandidates, stripImagesFromRequest } from "../routing/selection.js";
import { RoutingState } from "../routing/state.js";
import { buildUpstreams } from "../upstreams/factory.js";
import type { Upstream, UpstreamCallOptions } from "../upstreams/types.js";
import { type Logger, logger } from "../util/logger.js";

export const VIRTUAL_MODELS = ["fusion"] as const;

export interface RouteMeta {
  decision: RouteDecision;
  servedBy: string;
  panelMembers?: string[];
  /** The actor model that executed an agentic council-then-act turn. */
  actorId?: string;
  /** Advisor models that deliberated before the actor acted (council-then-act). */
  councilMembers?: string[];
}

export type RouteOutcome =
  | { mode: "stream"; meta: RouteMeta; stream: AsyncGenerator<StreamEvent> }
  | { mode: "result"; meta: RouteMeta; result: NeutralResult };

/** The wired application: upstreams, capability resolver, routing state, executor, classifier. */
export class App {
  readonly config: FusionConfig;
  readonly upstreams: Map<string, Upstream>;
  readonly resolver: CapabilityResolver;
  readonly state: RoutingState;
  readonly executor: Executor;
  readonly classifier: ComplexityClassifier;

  constructor(config: FusionConfig, classifier?: ComplexityClassifier) {
    this.config = config;
    this.upstreams = buildUpstreams(config);
    this.resolver = new CapabilityResolver(this.upstreams, config);
    this.state = new RoutingState(config.pools);
    this.executor = new Executor(
      this.upstreams,
      this.state,
      config.caching.sessionAffinity.enabled,
    );
    // classifier is injectable (tests pass a stub embedder to avoid loading ONNX)
    this.classifier =
      classifier ??
      new ComplexityClassifier(
        buildEmbedder(config.routing.smart.embeddings),
        config.routing.smart,
      );
  }

  async init(): Promise<void> {
    await this.resolver.start();
    // Warm the embedding model + anchor centroids in the background so the
    // server starts listening immediately; classify() awaits readiness on first use.
    if (this.config.routing.mode === "smart") {
      void this.classifier.init();
    }
  }

  shutdown(): void {
    this.resolver.stop();
  }

  modelFloor(): Capabilities {
    return this.resolver.floorFor([...this.state.orchestrator.members]);
  }

  /** Decide the route and execute it (single or panel), returning a unified outcome. */
  async route(
    req: NeutralRequest,
    override: RouteOverride,
    depth: number,
    signal: AbortSignal,
    log: Logger = logger,
  ): Promise<RouteOutcome> {
    const firstPanel = this.state.firstPanelName();
    let decision = decideStatic(req, this.config.routing, depth, override, firstPanel);
    if (!decision) {
      // smart mode: classify with the local embedding model
      const started = Date.now();
      const cls = await this.classifier.classify(req, log);
      decision = fromTier(
        cls.tier,
        this.config.routing,
        resolvePanel(this.config.routing, override, firstPanel),
        `smart[${cls.source}]: ${cls.reason}`,
        cls.scores,
      );
      log.info("classified request", {
        tier: cls.tier,
        source: cls.source,
        tokenEstimate: cls.tokenEstimate,
        scores: cls.scores,
        ms: Date.now() - started,
      });
    }

    // Invariant: a tool-bearing request must never hit the panel (it can't merge
    // tool calls in v0 → the agent loop stalls). Degrade to single, loudly.
    const hasTools = (req.tools?.length ?? 0) > 0;
    const safe = disablePanelWhenTools(decision, hasTools);
    if (safe !== decision) {
      log.warn("tools present -> panel disabled; routing single", {
        panel: decision.panelName,
        tier: decision.tier,
        reason: safe.reason,
      });
      decision = safe;
    }

    // Panel route (validate the panel exists; otherwise degrade to single).
    if (
      decision.mode === "panel" &&
      decision.panelName &&
      this.state.panelRing(decision.panelName)
    ) {
      log.info("route", {
        strategy: "panel",
        panel: decision.panelName,
        tier: decision.tier,
        reason: decision.reason,
      });
      const outcome = await runPanel(decision.panelName, req, depth, signal, {
        executor: this.executor,
        state: this.state,
        resolver: this.resolver,
        config: this.config,
        upstreams: this.upstreams,
        log,
      });
      const meta: RouteMeta = {
        decision,
        servedBy: outcome.judgeId,
        panelMembers: outcome.panelMembers,
      };
      log.info("panel complete", { judge: outcome.judgeId, members: outcome.panelMembers });
      return outcome.kind === "stream"
        ? { mode: "stream", meta, stream: outcome.stream }
        : { mode: "result", meta, result: outcome.result };
    }

    // Council-then-act: on a hard agentic (tool) turn, let a panel of advisors
    // deliberate (text-only), then the pinned actor executes WITH the real tools
    // plus that briefing. Classify here (tool turns normally skip the classifier);
    // if it's unavailable, act without the council rather than failing the turn.
    const council = this.config.routing.council;
    if (council.enabled && hasTools && decision.mode === "single" && depth < MAX_DEPTH) {
      let convene = false;
      let tier: Tier | undefined;
      try {
        const cls = await this.classifier.classify(req, log);
        tier = cls.tier;
        convene = shouldConvene(cls.tier, council.trigger);
        log.info("council gate", {
          tier: cls.tier,
          source: cls.source,
          trigger: council.trigger,
          convene,
        });
      } catch (err) {
        log.warn("council gate: classifier unavailable; acting without council", {
          error: (err as Error).message,
        });
      }
      if (convene) {
        const actorRing = this.state.singleRing(decision.poolName);
        const outcome = await runCouncilThenAct(actorRing, req, depth, signal, {
          executor: this.executor,
          state: this.state,
          resolver: this.resolver,
          config: this.config,
          upstreams: this.upstreams,
          log,
        });
        const meta: RouteMeta = {
          decision: tier ? { ...decision, tier } : decision,
          servedBy: outcome.actorId,
          actorId: outcome.actorId,
          councilMembers: outcome.councilMembers,
        };
        log.info("served", {
          servedBy: outcome.actorId,
          council: outcome.councilMembers,
          stream: req.stream,
        });
        return outcome.kind === "stream"
          ? { mode: "stream", meta, stream: outcome.stream }
          : { mode: "result", meta, result: outcome.result };
      }
    }

    // Single route over the tier's ring (orchestrator | compact | regular | actor).
    const ring = this.state.singleRing(decision.poolName);
    const members = [...ring.members];
    log.info("route", {
      strategy: "single",
      pool: decision.poolName ?? "orchestrator",
      tier: decision.tier,
      members,
      reason: decision.reason,
    });
    const selection = selectCandidates(members, req, this.resolver, this.config.routing);
    if (selection.error) throw new ImageRouteError(selection.error);
    const effReq = selection.stripImages ? stripImagesFromRequest(req) : req;
    if (selection.stripImages)
      log.warn("stripped images (no vision model in pool)", { pool: decision.poolName });
    const promptCacheKey = this.config.caching.promptCacheKey.enabled
      ? `fusion-${req.sessionId}`
      : undefined;
    const opts: UpstreamCallOptions = {
      signal,
      maxTokens: selection.maxTokens,
      depth: depth + 1,
      ...(promptCacheKey ? { promptCacheKey } : {}),
    };

    if (req.stream) {
      const { id, stream } = await this.executor.openStream(ring, effReq, opts, selection.excluded);
      log.info("served", {
        servedBy: id,
        stream: true,
        maxTokens: selection.maxTokens,
        hasImages: hasImages(req),
      });
      return { mode: "stream", meta: { decision, servedBy: id }, stream };
    }
    const { id, result } = await this.executor.complete(ring, effReq, opts, selection.excluded);
    log.info("served", {
      servedBy: id,
      stream: false,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      finishReason: result.stopReason,
    });
    if (result.stopReason === "length") {
      log.warn("response truncated at max_tokens", {
        servedBy: id,
        maxTokens: selection.maxTokens,
      });
    }
    return { mode: "result", meta: { decision, servedBy: id }, result };
  }
}

/** Serialize route metadata for the `x-fusion-route` debug header. */
export function fusionRouteHeader(meta: RouteMeta): string {
  const parts = [`mode=${meta.decision.mode}`];
  if (meta.decision.tier) parts.push(`tier=${meta.decision.tier}`);
  parts.push(`served_by=${meta.servedBy}`);
  if (meta.panelMembers && meta.panelMembers.length > 0) {
    parts.push(`panel=${meta.panelMembers.join("+")}`);
  }
  if (meta.actorId) parts.push(`actor=${meta.actorId}`);
  if (meta.councilMembers && meta.councilMembers.length > 0) {
    parts.push(`council=${meta.councilMembers.join("+")}`);
  }
  if (meta.decision.scores) {
    const s = meta.decision.scores;
    parts.push(
      `scores=compact:${s.compact.toFixed(2)},regular:${s.regular.toFixed(2)},plan:${s.plan.toFixed(2)}`,
    );
  }
  parts.push(`reason=${meta.decision.reason.replace(/\s+/g, "_")}`);
  // HTTP header values must be printable ASCII; strip anything else (e.g. "≥").
  return parts.join("; ").replace(/[^\x20-\x7E]/g, "");
}

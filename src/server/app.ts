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
import { ImageRouteError, runPanel } from "../panel/orchestrator.js";
import { ComplexityClassifier } from "../routing/classifier.js";
import { Executor } from "../routing/failover.js";
import {
  decideStatic,
  fromTier,
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

    // Single route over the tier's ring (orchestrator | compact | regular).
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

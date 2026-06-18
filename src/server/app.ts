import { CapabilityResolver } from "../capabilities/resolver.js";
import type { Capabilities } from "../capabilities/types.js";
import type { FusionConfig } from "../config/schema.js";
import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import { runPanel } from "../panel/orchestrator.js";
import { Executor } from "../routing/failover.js";
import { decideRoute, type RouteDecision, type RouteOverride } from "../routing/router.js";
import { selectCandidates, stripImagesFromRequest } from "../routing/selection.js";
import { RoutingState } from "../routing/state.js";
import { ImageRouteError } from "../panel/orchestrator.js";
import { buildUpstreams } from "../upstreams/factory.js";
import type { Upstream, UpstreamCallOptions } from "../upstreams/types.js";

export const VIRTUAL_MODELS = ["fusion/coder", "fusion/panel", "claude-fusion"] as const;

export interface RouteMeta {
  decision: RouteDecision;
  servedBy: string;
  panelMembers?: string[];
}

export type RouteOutcome =
  | { mode: "stream"; meta: RouteMeta; stream: AsyncGenerator<StreamEvent> }
  | { mode: "result"; meta: RouteMeta; result: NeutralResult };

/** The wired application: upstreams, capability resolver, routing state, executor. */
export class App {
  readonly config: FusionConfig;
  readonly upstreams: Map<string, Upstream>;
  readonly resolver: CapabilityResolver;
  readonly state: RoutingState;
  readonly executor: Executor;

  constructor(config: FusionConfig) {
    this.config = config;
    this.upstreams = buildUpstreams(config);
    this.resolver = new CapabilityResolver(this.upstreams, config);
    this.state = new RoutingState(config.pools);
    this.executor = new Executor(
      this.upstreams,
      this.state,
      config.caching.sessionAffinity.enabled,
    );
  }

  async init(): Promise<void> {
    await this.resolver.start();
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
  ): Promise<RouteOutcome> {
    const decision = decideRoute(req, this.config.routing, depth, override, [
      ...this.state.panels.keys(),
    ]);

    if (decision.mode === "panel" && decision.panelName) {
      const outcome = await runPanel(decision.panelName, req, depth, signal, {
        executor: this.executor,
        state: this.state,
        resolver: this.resolver,
        config: this.config,
        upstreams: this.upstreams,
      });
      const meta: RouteMeta = {
        decision,
        servedBy: outcome.judgeId,
        panelMembers: outcome.panelMembers,
      };
      return outcome.kind === "stream"
        ? { mode: "stream", meta, stream: outcome.stream }
        : { mode: "result", meta, result: outcome.result };
    }

    // single route over the orchestrator ring
    const members = [...this.state.orchestrator.members];
    const selection = selectCandidates(members, req, this.resolver, this.config.routing);
    if (selection.error) throw new ImageRouteError(selection.error);
    const effReq = selection.stripImages ? stripImagesFromRequest(req) : req;
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
      const { id, stream } = await this.executor.openStream(
        this.state.orchestrator,
        effReq,
        opts,
        selection.excluded,
      );
      return { mode: "stream", meta: { decision, servedBy: id }, stream };
    }
    const { id, result } = await this.executor.complete(
      this.state.orchestrator,
      effReq,
      opts,
      selection.excluded,
    );
    return { mode: "result", meta: { decision, servedBy: id }, result };
  }
}

/** Serialize route metadata for the `x-fusion-route` debug header. */
export function fusionRouteHeader(meta: RouteMeta): string {
  const parts = [`mode=${meta.decision.mode}`, `served_by=${meta.servedBy}`];
  if (meta.panelMembers && meta.panelMembers.length > 0) {
    parts.push(`panel=${meta.panelMembers.join("+")}`);
  }
  parts.push(`reason=${meta.decision.reason.replace(/\s+/g, "_")}`);
  // HTTP header values must be printable ASCII; strip anything else (e.g. "≥").
  return parts.join("; ").replace(/[^\x20-\x7E]/g, "");
}

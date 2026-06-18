import { clampMaxTokens } from "../capabilities/intersect.js";
import type { CapabilityResolver } from "../capabilities/resolver.js";
import type { FusionConfig } from "../config/schema.js";
import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import { flattenText } from "../neutral/types.js";
import { type Executor, RingExhaustedError } from "../routing/failover.js";
import { selectCandidates, stripImagesFromRequest } from "../routing/selection.js";
import type { RoutingState } from "../routing/state.js";
import type { UpstreamCallOptions } from "../upstreams/types.js";
import { UpstreamError } from "../upstreams/types.js";
import { JUDGE_SYSTEM, originalUserText, renderJudgePrompt } from "./prompts.js";

export type PanelOutcome =
  | { kind: "stream"; panelMembers: string[]; judgeId: string; stream: AsyncGenerator<StreamEvent> }
  | { kind: "result"; panelMembers: string[]; judgeId: string; result: NeutralResult };

export interface PanelDeps {
  executor: Executor;
  state: RoutingState;
  resolver: CapabilityResolver;
  config: FusionConfig;
  upstreams: Map<
    string,
    { complete: (req: NeutralRequest, opts: UpstreamCallOptions) => Promise<NeutralResult> }
  >;
}

/**
 * Run a panel: fan out to members in parallel (non-streaming), then aggregate
 * with a judge selected round-robin from the orchestrator pool. Only the judge
 * streams to the client.
 */
export async function runPanel(
  panelName: string,
  req: NeutralRequest,
  depth: number,
  signal: AbortSignal,
  deps: PanelDeps,
): Promise<PanelOutcome> {
  const { executor, state, resolver, config, upstreams } = deps;
  const ring = state.panelRing(panelName);
  if (!ring || ring.size === 0) {
    throw new Error(`Panel "${panelName}" has no members`);
  }

  // Rotate member order each request (round-robin over the opinion-givers).
  const ordered = ring.iterateFrom(ring.next());
  const selection = selectCandidates(ordered, req, resolver, config.routing);
  if (selection.error) throw new ImageRouteError(selection.error);
  const memberReq = selection.stripImages ? stripImagesFromRequest(req) : req;
  const activeMembers = ordered.filter((id) => !selection.excluded.has(id));

  const promptCacheKey = config.caching.promptCacheKey.enabled
    ? `fusion-${req.sessionId}`
    : undefined;
  const memberOpts: UpstreamCallOptions = {
    signal,
    maxTokens: selection.maxTokens,
    depth: depth + 1,
    ...(promptCacheKey ? { promptCacheKey } : {}),
  };

  const settled = await Promise.allSettled(
    activeMembers.map(async (id) => {
      const breaker = state.breaker(id);
      if (!breaker.canTry(Date.now())) throw new Error(`breaker open: ${id}`);
      const upstream = upstreams.get(id);
      if (!upstream) throw new Error(`unknown upstream: ${id}`);
      try {
        const result = await upstream.complete({ ...memberReq, stream: false }, memberOpts);
        breaker.onSuccess();
        return { id, result };
      } catch (err) {
        const retryAfter = err instanceof UpstreamError ? err.retryAfterMs : null;
        breaker.onFailure(Date.now(), retryAfter);
        throw err;
      }
    }),
  );

  const good = settled
    .filter(
      (s): s is PromiseFulfilledResult<{ id: string; result: NeutralResult }> =>
        s.status === "fulfilled",
    )
    .map((s) => s.value);

  if (good.length === 0) {
    throw new RingExhaustedError(
      activeMembers,
      settled.find((s) => s.status === "rejected"),
    );
  }

  // Build the judge request from the panel answers.
  const answers = good.map((g, i) => ({
    label: `Answer ${i + 1}`,
    text: flattenText(g.result.content),
  }));
  const judgeReq: NeutralRequest = {
    model: req.model,
    system: [{ kind: "text", text: JUDGE_SYSTEM }],
    messages: [
      {
        role: "user",
        content: [{ kind: "text", text: renderJudgePrompt(originalUserText(req), answers) }],
      },
    ],
    stream: req.stream,
    sessionId: req.sessionId,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };

  const judgeFloor = resolver.floorFor([...state.orchestrator.members]);
  const judgeOpts: UpstreamCallOptions = {
    signal,
    maxTokens: clampMaxTokens(req.maxTokens, judgeFloor),
    depth: depth + 1,
    ...(promptCacheKey ? { promptCacheKey } : {}),
  };
  const panelMembers = good.map((g) => g.id);

  if (req.stream) {
    const { id: judgeId, stream } = await executor.openStream(
      state.orchestrator,
      judgeReq,
      judgeOpts,
    );
    return { kind: "stream", panelMembers, judgeId, stream };
  }
  const { id: judgeId, result } = await executor.complete(state.orchestrator, judgeReq, judgeOpts);
  return { kind: "result", panelMembers, judgeId, result };
}

export class ImageRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRouteError";
  }
}

import { clampMaxTokens } from "../capabilities/intersect.js";
import type { CouncilConfig } from "../config/schema.js";
import {
  type ContentPart,
  flattenText,
  type NeutralRequest,
  type NeutralResult,
  type StreamEvent,
  type ToolCall,
} from "../neutral/types.js";
import type { RoundRobinRing } from "../routing/ring.js";
import { selectCandidates, stripImagesFromRequest } from "../routing/selection.js";
import type { UpstreamCallOptions } from "../upstreams/types.js";
import { type Logger, logger } from "../util/logger.js";
import { completeMembers, type PanelDeps } from "./orchestrator.js";
import {
  COUNCIL_BRIEFING_SYSTEM,
  COUNCIL_SYSTEM,
  originalUserText,
  renderBriefingPrompt,
  renderCouncilPrompt,
} from "./prompts.js";

export type CouncilOutcome =
  | {
      kind: "stream";
      actorId: string;
      councilMembers: string[];
      stream: AsyncGenerator<StreamEvent>;
    }
  | { kind: "result"; actorId: string; councilMembers: string[]; result: NeutralResult };

const TIER_RANK: Record<string, number> = { compact: 0, regular: 1, plan: 2 };

/** Whether a classified tier meets the council's trigger threshold. */
export function shouldConvene(tier: string, trigger: CouncilConfig["trigger"]): boolean {
  if (trigger === "always") return true;
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[trigger] ?? 99);
}

/** Render a member's proposed tool calls as readable advice text. */
function renderProposedCalls(calls: ToolCall[] | undefined): string {
  if (!calls || calls.length === 0) return "";
  const rendered = calls.map((c) => `${c.name}(${c.arguments})`).join("; ");
  return `Proposed action: ${rendered}`;
}

/** Tool names the actor has available, for the advisors' context. */
function toolNames(req: NeutralRequest): string[] {
  return (req.tools ?? []).map((t) => t.name);
}

/**
 * Council-then-act. On a hard agentic turn, a panel of advisor models deliberates
 * as TEXT (they never execute tools — that would stall the agent loop), an optional
 * judge condenses their opinions into a briefing, and the pinned actor model runs
 * WITH the real tools plus the briefing injected into its context. The actor is
 * ALWAYS executed: if the council can't run (no advisors, all fail, etc.) we fall
 * back to a plain actor turn (logged, never silent) so the agent keeps working.
 */
export async function runCouncilThenAct(
  actorRing: RoundRobinRing<string>,
  req: NeutralRequest,
  depth: number,
  signal: AbortSignal,
  deps: PanelDeps,
): Promise<CouncilOutcome> {
  const { executor, resolver, config } = deps;
  const log = deps.log ?? logger;
  const promptCacheKey = config.caching.promptCacheKey.enabled
    ? `fusion-${req.sessionId}`
    : undefined;

  const briefing = await deliberate(req, depth, signal, deps, log);

  // Inject the briefing as an extra system part (preserves the conversation).
  const actorReq: NeutralRequest = briefing
    ? {
        ...req,
        system: [
          ...(req.system ?? []),
          {
            kind: "text",
            text: `Council briefing (advisory, for THIS step):\n${briefing.text}`,
          } satisfies ContentPart,
        ],
      }
    : req;

  const actorFloor = resolver.floorFor([...actorRing.members]);
  const actorOpts: UpstreamCallOptions = {
    signal,
    maxTokens: clampMaxTokens(req.maxTokens, actorFloor),
    depth: depth + 1,
    ...(promptCacheKey ? { promptCacheKey } : {}),
  };
  const councilMembers = briefing?.members ?? [];
  log.info("council acting", {
    actorPool: [...actorRing.members],
    council: councilMembers,
    briefed: briefing !== null,
  });

  if (req.stream) {
    const { id: actorId, stream } = await executor.openStream(actorRing, actorReq, actorOpts);
    return { kind: "stream", actorId, councilMembers, stream };
  }
  const { id: actorId, result } = await executor.complete(actorRing, actorReq, actorOpts);
  return { kind: "result", actorId, councilMembers, result };
}

/**
 * Fan out the advisor panel and (optionally) synthesize a briefing. Returns null
 * when no advice could be produced (caller then runs the actor unbriefed).
 */
async function deliberate(
  req: NeutralRequest,
  depth: number,
  signal: AbortSignal,
  deps: PanelDeps,
  log: Logger,
): Promise<{ text: string; members: string[] } | null> {
  const { executor, state, resolver, config } = deps;
  const council = config.routing.council;
  const ring = state.panelRing(council.panel);
  if (!ring || ring.size === 0) {
    log.warn("council enabled but advisor panel is empty; acting without council", {
      panel: council.panel,
    });
    return null;
  }

  const ordered = ring.iterateFrom(ring.next());
  const selection = selectCandidates(ordered, req, resolver, config.routing);
  if (selection.error) {
    // e.g. images with no vision advisor — advisors can't see it; let the actor handle it.
    log.warn("council skipped (advisors cannot serve this request); acting alone", {
      reason: selection.error,
    });
    return null;
  }

  // Exclude the actor model(s) from the advisor set for diversity (the actor
  // integrates the advice anyway).
  const actorMembers = new Set(council.excludeActor ? state.singleRing("actor").members : []);
  const advisors = ordered.filter((id) => !selection.excluded.has(id) && !actorMembers.has(id));
  if (advisors.length === 0) {
    log.warn("council has no advisors after exclusions; acting without council", {
      panel: council.panel,
    });
    return null;
  }

  const userText = originalUserText(req);
  const baseReq = selection.stripImages ? stripImagesFromRequest(req) : req;
  const councilReq: NeutralRequest = {
    ...baseReq,
    system: [
      ...(baseReq.system ?? []),
      { kind: "text", text: COUNCIL_SYSTEM },
      { kind: "text", text: renderCouncilPrompt(userText, toolNames(req)) },
    ],
  };

  const promptCacheKey = config.caching.promptCacheKey.enabled
    ? `fusion-${req.sessionId}`
    : undefined;
  const memberOpts: UpstreamCallOptions = {
    signal,
    maxTokens: selection.maxTokens,
    depth: depth + 1,
    ...(promptCacheKey ? { promptCacheKey } : {}),
  };

  log.info("council convened", { panel: council.panel, advisors });
  const { good } = await completeMembers(advisors, councilReq, memberOpts, deps, log, "council");
  if (good.length === 0) {
    log.warn("all council advisors failed; acting without council", { advisors });
    return null;
  }

  const opinions = good.map((g) => ({
    label: g.id,
    text: [flattenText(g.result.content), renderProposedCalls(g.result.toolCalls)]
      .filter(Boolean)
      .join("\n"),
  }));
  const members = good.map((g) => g.id);

  if (!council.synthesize) {
    const raw = opinions.map((o) => `<<${o.label}>>\n${o.text.trim()}`).join("\n\n");
    log.info("council briefing (raw opinions)", { members, chars: raw.length });
    return { text: raw, members };
  }

  // Synthesize a bounded briefing with a judge over the orchestrator ring.
  try {
    const briefingReq: NeutralRequest = {
      model: req.model,
      system: [{ kind: "text", text: COUNCIL_BRIEFING_SYSTEM }],
      messages: [
        {
          role: "user",
          content: [{ kind: "text", text: renderBriefingPrompt(userText, opinions) }],
        },
      ],
      stream: false,
      sessionId: req.sessionId,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    const judgeFloor = resolver.floorFor([...state.orchestrator.members]);
    const { id: judgeId, result } = await executor.complete(state.orchestrator, briefingReq, {
      signal,
      maxTokens: clampMaxTokens(req.maxTokens, judgeFloor),
      depth: depth + 1,
      ...(promptCacheKey ? { promptCacheKey } : {}),
    });
    const text = flattenText(result.content);
    log.info("council briefing", { judge: judgeId, members, chars: text.length });
    return { text, members };
  } catch (err) {
    // Judge failed — fall back to the raw opinions rather than dropping the council.
    const raw = opinions.map((o) => `<<${o.label}>>\n${o.text.trim()}`).join("\n\n");
    log.warn("council briefing judge failed; using raw advisor opinions", {
      error: (err as Error).message,
    });
    return { text: raw, members };
  }
}

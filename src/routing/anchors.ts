/** Complexity tiers and their default anchor phrases for the smart router. */

export const TIERS = ["compact", "regular", "plan"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Default anchor utterances per tier. The classifier embeds these, averages
 * each tier into a centroid, and assigns an incoming request to the nearest
 * tier by cosine similarity. Phrased as natural code-task sentences. Override
 * via `routing.smart.anchors` in config.
 */
export const DEFAULT_ANCHORS: Record<Tier, string[]> = {
  compact: [
    "fix this typo",
    "rename this variable",
    "what does this function do",
    "add a log line here",
    "format this file",
    "what is the type of this value",
    "change this string",
    "import this module",
    "bump the version number",
  ],
  regular: [
    "implement this function",
    "write a unit test for this code",
    "add error handling to this handler",
    "fix this bug in the parser",
    "add a new field to this type and use it",
    "refactor this function to be cleaner",
    "update this endpoint to accept a new parameter",
    "convert this loop to use map and filter",
    "wire this component into the page",
  ],
  plan: [
    "design the architecture for a new service",
    "produce a step by step implementation plan",
    "refactor this whole module across many files",
    "compare these approaches and recommend a design",
    "plan a migration from one database to another",
    "debug this intermittent production issue and propose root causes and fixes",
    "design the data model and API for this feature",
    "evaluate the trade-offs of these system designs",
    "break this large feature into milestones",
  ],
};

/**
 * Harness-mode anchors. Coding agents inject distinctive instructions when they
 * enter "plan mode" (read-only, present a plan) or run conversation
 * compaction/summarization. We detect these SEMANTICALLY (embedding similarity)
 * over the latest/system segments — never by substring — because words like
 * "plan" appear in normal system prompts too. Sourced from the real prompts of
 * Claude Code, opencode, Cline, and Aider. A plan-mode session routes to the
 * `plan` tier (all hands); a compaction request routes to `compact` (one model).
 */
export const HARNESS_ANCHORS: Record<"plan" | "compact", string[]> = {
  plan: [
    "Plan mode is active. The user indicated that they do not want you to execute yet -- you must not make any edits, run any non-readonly tools, or otherwise make any changes to the system. This supersedes any other instructions you have received.",
    "This is a read-only exploration and planning phase. Do not write or edit any files yet.",
    "When ready, use ExitPlanMode to present your plan for approval.",
    "CRITICAL: Plan mode active - you are in a read-only phase. Strictly forbidden: any file edits, modifications, or system changes. You may only observe, analyze, and plan.",
    "In plan mode, gather information and context to create a detailed plan for accomplishing the task, which the user will review and approve before switching to act mode to implement.",
    "Act as an expert architect engineer and provide direction to your editor engineer; describe how to modify the code to complete the request.",
  ],
  compact: [
    "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
    "Before providing your final summary, wrap your analysis in analysis tags to organize your thoughts and ensure you have covered all necessary points.",
    "Your summary should include the following sections: Primary Request and Intent, Key Technical Concepts, Files and Code Sections, Pending Tasks, Current Work, Optional Next Step.",
    "List all user messages that are not tool results; these are critical for understanding the user's feedback and changing intent.",
    "Write a continuation summary of the work so far so another assistant can continue the task.",
  ],
};

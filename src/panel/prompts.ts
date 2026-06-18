import { flattenText, type NeutralRequest } from "../neutral/types.js";

export const JUDGE_SYSTEM =
  "You are an expert aggregator. You will be shown a user request and several " +
  "candidate answers from different assistants. Synthesize a single, best answer: " +
  "prefer claims that multiple candidates agree on, resolve conflicts by correctness " +
  "and sound reasoning, incorporate unique correct insights, and discard mistakes. " +
  "Do not mention that multiple drafts existed or that you are aggregating. Respond " +
  "directly to the user as one coherent answer.";

/** The original user request text, used to ground the judge. */
export function originalUserText(req: NeutralRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m && m.role === "user") return flattenText(m.content);
  }
  return "";
}

export function renderJudgePrompt(
  userText: string,
  answers: { label: string; text: string }[],
): string {
  const blocks = answers.map((a) => `<<${a.label}>>\n${a.text.trim()}`).join("\n\n");
  return (
    `User request:\n${userText.trim()}\n\n` +
    `Candidate answers:\n\n${blocks}\n\n` +
    `Now write the single best answer to the user request.`
  );
}

/**
 * Council deliberation: an advisor reasons about the next step WITHOUT executing
 * tools. Its output becomes advice an "actor" model (which holds the real tools)
 * weighs before acting. Appended to the advisor's system prompt.
 */
export const COUNCIL_SYSTEM =
  "You are one member of an expert council advising a coding agent (the 'actor') " +
  "that will take the next action. Do NOT call tools or take actions yourself — " +
  "another model executes. Read the conversation and the actor's available tools, " +
  "then give concise, concrete advice for the next step: what to do, which tool(s) " +
  "and arguments you would use, key risks or edge cases, and anything the actor " +
  "might miss. Be specific and brief; bullet points are fine.";

/** Synthesizes advisor opinions into one bounded briefing for the actor. */
export const COUNCIL_BRIEFING_SYSTEM =
  "You are the council chair. You will be shown several advisors' recommendations " +
  "for a coding agent's next step. Produce a SHORT briefing for the actor with: " +
  "the recommended next action, key considerations/risks the advisors raised, and " +
  "any notable disagreement. Be decisive and concise — this is guidance, not the " +
  "final answer, and the actor holds the real tools.";

export function renderCouncilPrompt(userText: string, toolNames: string[]): string {
  const tools = toolNames.length > 0 ? toolNames.join(", ") : "(none advertised)";
  return (
    `Current user request / focus:\n${userText.trim()}\n\n` +
    `Tools available to the actor: ${tools}\n\n` +
    `Advise the actor on the best next step.`
  );
}

export function renderBriefingPrompt(
  userText: string,
  opinions: { label: string; text: string }[],
): string {
  const blocks = opinions.map((o) => `<<${o.label}>>\n${o.text.trim()}`).join("\n\n");
  return (
    `User request / focus:\n${userText.trim()}\n\n` +
    `Advisor recommendations:\n\n${blocks}\n\n` +
    `Now write the short briefing for the actor.`
  );
}

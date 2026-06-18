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

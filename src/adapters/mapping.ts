import type { StopReason } from "../neutral/types.js";

/** OpenAI Chat Completions `finish_reason` → neutral StopReason. */
export function openaiFinishToNeutral(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "stop":
    default:
      return "stop";
  }
}

/** Neutral StopReason → OpenAI `finish_reason`. */
export function neutralToOpenaiFinish(reason: StopReason): string {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "error":
    case "stop":
    default:
      return "stop";
  }
}

/** Anthropic `stop_reason` → neutral StopReason. */
export function anthropicStopToNeutral(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    default:
      return "stop";
  }
}

/** Neutral StopReason → Anthropic `stop_reason`. */
export function neutralToAnthropicStop(reason: StopReason): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    case "error":
    case "stop":
    default:
      return "end_turn";
  }
}

/** Responses API status/output → neutral StopReason (function calls override). */
export function responsesStatusToNeutral(
  status: string | null | undefined,
  hasToolCalls: boolean,
): StopReason {
  if (hasToolCalls) return "tool_calls";
  if (status === "incomplete") return "length";
  return "stop";
}

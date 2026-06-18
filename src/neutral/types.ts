/**
 * The canonical internal representation.
 *
 * Every client wire format (OpenAI Chat Completions, Anthropic Messages) and
 * every upstream wire format (OpenAI Chat Completions, OpenAI Responses,
 * Anthropic Messages) converts to/from these types. Keeping one neutral format
 * avoids N×M adapters and lets each adapter be unit-tested in isolation.
 *
 * Design notes:
 * - Tool-call `arguments` is a raw JSON string end-to-end. Only the Anthropic
 *   edge (where `tool_use.input` is an object) parses/stringifies.
 * - `system` is kept separate from `messages` because Anthropic and the
 *   Responses API both model it separately (and it is the natural place to put
 *   cache breakpoints).
 * - Build objects with conditional spreads, never `field: undefined`, because
 *   the tsconfig enables `exactOptionalPropertyTypes`.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export type Modality = "text" | "image";

/** A piece of message content. */
export type ContentPart =
  | { kind: "text"; text: string }
  | {
      kind: "image";
      mediaType: string;
      /** Either inline base64 bytes or a remote URL the provider can fetch. */
      source: { type: "base64"; data: string } | { type: "url"; url: string };
    };

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of the arguments (never pre-parsed). */
  arguments: string;
}

export interface NeutralMessage {
  role: Role;
  /** Text/image parts. Empty for a pure tool-call assistant turn. */
  content: ContentPart[];
  /** assistant → requested tool calls. */
  toolCalls?: ToolCall[];
  /** role:"tool" → which call this result answers. */
  toolCallId?: string;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface NeutralRequest {
  /** The *virtual* model id the client asked for (e.g. "fusion/coder"). */
  model: string;
  /** Separated system content (Anthropic-native; OpenAI folds it into messages). */
  system?: ContentPart[];
  messages: NeutralMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  /** Client-requested max output tokens; clamped later to the route floor. */
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  /** Derived stable session id; drives cache key + affinity. */
  sessionId: string;
  metadata?: Record<string, string>;
}

export type StopReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export interface NeutralUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface NeutralResult {
  /** The upstream model id that actually served the request. */
  model: string;
  content: ContentPart[];
  toolCalls?: ToolCall[];
  stopReason: StopReason;
  usage: NeutralUsage;
}

/** Neutral streaming event union produced by upstreams and consumed by `*-out` adapters. */
export type StreamEvent =
  | { type: "start"; model: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-call-start"; index: number; id: string; name: string }
  | { type: "tool-call-delta"; index: number; argsDelta: string }
  | { type: "usage"; usage: NeutralUsage }
  | { type: "stop"; reason: StopReason }
  | { type: "error"; message: string; retryable: boolean };

/** Concatenate all text parts of a content array (images become a short placeholder). */
export function flattenText(content: ContentPart[]): string {
  return content
    .map((part) => (part.kind === "text" ? part.text : `[image:${part.mediaType}]`))
    .join("");
}

/** Whether any message (or system) carries an image part. */
export function hasImages(req: NeutralRequest): boolean {
  const inSystem = (req.system ?? []).some((p) => p.kind === "image");
  if (inSystem) return true;
  return req.messages.some((m) => m.content.some((p) => p.kind === "image"));
}

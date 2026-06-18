import {
  type ContentPart,
  type NeutralRequest,
  type NeutralResult,
  type StreamEvent,
  type ToolCall,
  flattenText,
} from "../neutral/types.js";
import type { UpstreamCallOptions } from "../upstreams/types.js";
import { imagePartToUrl } from "./content.js";
import { asObject, getArray, getNumber, getObject, getString, type JsonObject } from "./json.js";
import { responsesStatusToNeutral } from "./mapping.js";

// ----------------------------------------------------------------------------
// Upstream edge only: NeutralRequest  →  OpenAI Responses API body
// ----------------------------------------------------------------------------

function responsesContent(parts: ContentPart[], role: "user" | "assistant"): JsonObject[] {
  const textType = role === "assistant" ? "output_text" : "input_text";
  return parts.map((p) =>
    p.kind === "text"
      ? { type: textType, text: p.text }
      : { type: "input_image", image_url: imagePartToUrl(p) },
  );
}

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export function neutralToResponsesBody(
  req: NeutralRequest,
  upstreamModel: string,
  opts: UpstreamCallOptions,
): JsonObject {
  const input: JsonObject[] = [];
  for (const m of req.messages) {
    if (m.role === "user") {
      input.push({ type: "message", role: "user", content: responsesContent(m.content, "user") });
    } else if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? "",
        output: flattenText(m.content),
      });
    } else if (m.role === "assistant") {
      if (m.content.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: responsesContent(m.content, "assistant"),
        });
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
    }
  }

  const body: JsonObject = {
    model: upstreamModel,
    input,
    store: false,
    stream: req.stream,
    max_output_tokens: opts.maxTokens,
    reasoning: { effort: "medium", summary: "auto" },
  };
  // The Responses/codex backend requires non-empty `instructions`; fall back to
  // a default when the client sent no system prompt.
  const instructions = req.system && req.system.length > 0 ? flattenText(req.system) : "";
  body.instructions = instructions || DEFAULT_INSTRUCTIONS;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      parameters: t.parameters,
      ...(t.description ? { description: t.description } : {}),
    }));
  }
  if (req.toolChoice) {
    body.tool_choice =
      typeof req.toolChoice === "string"
        ? req.toolChoice
        : { type: "function", name: req.toolChoice.name };
  }
  if (opts.promptCacheKey) body.prompt_cache_key = opts.promptCacheKey;
  return body;
}

// ----------------------------------------------------------------------------
// Upstream edge: Responses response / stream  →  Neutral
// ----------------------------------------------------------------------------

export function responsesResponseToNeutral(json: unknown, fallbackModel: string): NeutralResult {
  const obj = asObject(json);
  const response = getObject(obj, "response") ?? obj;
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of getArray(response, "output")) {
    const type = getString(item, "type");
    if (type === "message") {
      for (const block of getArray(item, "content")) {
        const text = getString(block, "text");
        if (text) content.push({ kind: "text", text });
      }
    } else if (type === "function_call") {
      toolCalls.push({
        id: getString(item, "call_id") ?? getString(item, "id") ?? "",
        name: getString(item, "name") ?? "",
        arguments: getString(item, "arguments") ?? "",
      });
    }
  }

  const usage = getObject(response, "usage") ?? {};
  const cached = getNumber(getObject(usage, "input_tokens_details"), "cached_tokens");

  return {
    model: getString(response, "model") ?? fallbackModel,
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason: responsesStatusToNeutral(getString(response, "status"), toolCalls.length > 0),
    usage: {
      inputTokens: getNumber(usage, "input_tokens") ?? 0,
      outputTokens: getNumber(usage, "output_tokens") ?? 0,
      ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    },
  };
}

export async function* responsesStreamToNeutral(
  frames: AsyncIterable<{ event?: string; data: string }>,
  fallbackModel: string,
): AsyncGenerator<StreamEvent, void, unknown> {
  yield { type: "start", model: fallbackModel };
  const indexByOutput = new Map<number, number>();
  let toolOrdinal = 0;
  let stop: StreamEvent = { type: "stop", reason: "stop" };

  for await (const frame of frames) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const obj = asObject(parsed);
    const type = getString(obj, "type") ?? frame.event;

    if (type === "response.output_text.delta") {
      const delta = getString(obj, "delta");
      if (delta) yield { type: "text-delta", text: delta };
    } else if (type === "response.output_item.added") {
      const item = getObject(obj, "item") ?? {};
      if (getString(item, "type") === "function_call") {
        const outputIndex = getNumber(obj, "output_index") ?? toolOrdinal;
        const ordinal = toolOrdinal++;
        indexByOutput.set(outputIndex, ordinal);
        yield {
          type: "tool-call-start",
          index: ordinal,
          id: getString(item, "call_id") ?? getString(item, "id") ?? "",
          name: getString(item, "name") ?? "",
        };
      }
    } else if (type === "response.function_call_arguments.delta") {
      const outputIndex = getNumber(obj, "output_index") ?? 0;
      const ordinal = indexByOutput.get(outputIndex) ?? 0;
      const delta = getString(obj, "delta");
      if (delta) yield { type: "tool-call-delta", index: ordinal, argsDelta: delta };
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = getObject(obj, "response") ?? {};
      const usage = getObject(response, "usage");
      if (usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: getNumber(usage, "input_tokens") ?? 0,
            outputTokens: getNumber(usage, "output_tokens") ?? 0,
          },
        };
      }
      stop = {
        type: "stop",
        reason: responsesStatusToNeutral(getString(response, "status"), toolOrdinal > 0),
      };
    } else if (type === "response.failed" || type === "error") {
      yield { type: "error", message: "responses stream error", retryable: true };
      stop = { type: "stop", reason: "error" };
    }
  }
  yield stop;
}

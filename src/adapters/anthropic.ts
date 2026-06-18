import {
  type ContentPart,
  type NeutralMessage,
  type NeutralRequest,
  type NeutralResult,
  type StreamEvent,
  type ToolCall,
  type ToolChoice,
  type ToolDef,
  flattenText,
} from "../neutral/types.js";
import type { UpstreamCallOptions } from "../upstreams/types.js";
import { messageId } from "../util/id.js";
import { encodeSseJson } from "../util/sse.js";
import {
  asArray,
  asObject,
  getArray,
  getNumber,
  getObject,
  getString,
  isObject,
  type JsonObject,
} from "./json.js";
import { anthropicStopToNeutral, neutralToAnthropicStop } from "./mapping.js";

// ----------------------------------------------------------------------------
// Client edge: Anthropic Messages request  →  NeutralRequest
// ----------------------------------------------------------------------------

function systemToParts(system: unknown): ContentPart[] {
  if (typeof system === "string") return system ? [{ kind: "text", text: system }] : [];
  const parts: ContentPart[] = [];
  for (const block of asArray(system)) {
    const text = getString(block, "text");
    if (text) parts.push({ kind: "text", text });
  }
  return parts;
}

function imageBlockToPart(block: JsonObject): ContentPart | null {
  const source = getObject(block, "source");
  if (!source) return null;
  const type = getString(source, "type");
  if (type === "base64") {
    return {
      kind: "image",
      mediaType: getString(source, "media_type") ?? "image/*",
      source: { type: "base64", data: getString(source, "data") ?? "" },
    };
  }
  if (type === "url") {
    return {
      kind: "image",
      mediaType: "image/*",
      source: { type: "url", url: getString(source, "url") ?? "" },
    };
  }
  return null;
}

export function anthropicRequestToNeutral(body: unknown, sessionId: string): NeutralRequest {
  const obj = asObject(body);
  const model = getString(obj, "model") ?? "fusion";
  const system = systemToParts(obj.system);
  const messages: NeutralMessage[] = [];

  for (const raw of getArray(obj, "messages")) {
    const role = getString(raw, "role");
    const content = asObject(raw).content;
    if (typeof content === "string") {
      messages.push({
        role: role === "assistant" ? "assistant" : "user",
        content: content ? [{ kind: "text", text: content }] : [],
      });
      continue;
    }
    if (role === "assistant") {
      const parts: ContentPart[] = [];
      const toolCalls: ToolCall[] = [];
      for (const block of asArray(content)) {
        const type = getString(block, "type");
        if (type === "text") parts.push({ kind: "text", text: getString(block, "text") ?? "" });
        else if (type === "tool_use") {
          toolCalls.push({
            id: getString(block, "id") ?? "",
            name: getString(block, "name") ?? "",
            arguments: JSON.stringify(asObject(block).input ?? {}),
          });
        }
      }
      messages.push({
        role: "assistant",
        content: parts,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    // user turn: tool_result blocks become neutral tool messages; rest is a user message
    const userParts: ContentPart[] = [];
    for (const block of asArray(content)) {
      const type = getString(block, "type");
      if (type === "tool_result") {
        const inner = asObject(block).content;
        const text = typeof inner === "string" ? inner : flattenText(blocksToParts(inner));
        messages.push({
          role: "tool",
          content: [{ kind: "text", text }],
          toolCallId: getString(block, "tool_use_id") ?? "",
        });
      } else if (type === "text") {
        userParts.push({ kind: "text", text: getString(block, "text") ?? "" });
      } else if (type === "image") {
        const part = imageBlockToPart(asObject(block));
        if (part) userParts.push(part);
      }
    }
    if (userParts.length > 0) messages.push({ role: "user", content: userParts });
  }

  const tools = toolsFromAnthropic(obj.tools);
  const toolChoice = toolChoiceFromAnthropic(obj.tool_choice);
  const maxTokens = getNumber(obj, "max_tokens");
  const temperature = getNumber(obj, "temperature");
  const topP = getNumber(obj, "top_p");
  const stop = getArray(obj, "stop_sequences").filter((s): s is string => typeof s === "string");

  return {
    model,
    ...(system.length > 0 ? { system } : {}),
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(stop.length > 0 ? { stop } : {}),
    stream: obj.stream === true,
    sessionId,
  };
}

function blocksToParts(content: unknown): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of asArray(content)) {
    const text = getString(block, "text");
    if (text) parts.push({ kind: "text", text });
  }
  return parts;
}

function toolsFromAnthropic(raw: unknown): ToolDef[] | undefined {
  const tools: ToolDef[] = [];
  for (const tool of asArray(raw)) {
    const name = getString(tool, "name");
    if (!name) continue;
    const description = getString(tool, "description");
    const parameters = getObject(tool, "input_schema") ?? {};
    tools.push({ name, parameters, ...(description ? { description } : {}) });
  }
  return tools.length > 0 ? tools : undefined;
}

function toolChoiceFromAnthropic(raw: unknown): ToolChoice | undefined {
  if (!isObject(raw)) return undefined;
  const type = getString(raw, "type");
  if (type === "auto") return "auto";
  if (type === "none") return "none";
  if (type === "any") return "required";
  if (type === "tool") {
    const name = getString(raw, "name");
    if (name) return { name };
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// Client edge: NeutralResult / StreamEvent  →  Anthropic response
// ----------------------------------------------------------------------------

function toolCallsToBlocks(toolCalls: ToolCall[]): JsonObject[] {
  return toolCalls.map((tc) => {
    let input: unknown;
    try {
      input = tc.arguments ? JSON.parse(tc.arguments) : {};
    } catch {
      input = {};
    }
    return { type: "tool_use", id: tc.id || `toolu_${tc.name}`, name: tc.name, input };
  });
}

export function neutralResultToAnthropic(result: NeutralResult, modelEcho: string): JsonObject {
  const content: JsonObject[] = [];
  const text = flattenText(result.content);
  if (text) content.push({ type: "text", text });
  if (result.toolCalls && result.toolCalls.length > 0)
    content.push(...toolCallsToBlocks(result.toolCalls));

  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model: modelEcho,
    content,
    stop_reason: neutralToAnthropicStop(result.stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      ...(result.usage.cacheReadTokens !== undefined
        ? { cache_read_input_tokens: result.usage.cacheReadTokens }
        : {}),
      ...(result.usage.cacheWriteTokens !== undefined
        ? { cache_creation_input_tokens: result.usage.cacheWriteTokens }
        : {}),
    },
  };
}

/** Translate neutral stream events into the Anthropic SSE event sequence. */
export async function* neutralStreamToAnthropic(
  events: AsyncIterable<StreamEvent>,
  modelEcho: string,
): AsyncGenerator<string, void, unknown> {
  const id = messageId();
  let nextIndex = 0;
  let textIndex: number | null = null;
  const toolBlockIndex = new Map<number, number>();
  const openBlocks: number[] = [];
  let outputTokens = 0;
  let inputTokens = 0;
  let stopReason = "end_turn";

  yield encodeSseJson(
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: modelEcho,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    "message_start",
  );

  for await (const ev of events) {
    if (ev.type === "text-delta") {
      if (textIndex === null) {
        textIndex = nextIndex++;
        openBlocks.push(textIndex);
        yield encodeSseJson(
          {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: "text", text: "" },
          },
          "content_block_start",
        );
      }
      yield encodeSseJson(
        {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: ev.text },
        },
        "content_block_delta",
      );
    } else if (ev.type === "tool-call-start") {
      if (textIndex !== null) {
        yield encodeSseJson({ type: "content_block_stop", index: textIndex }, "content_block_stop");
        openBlocks.splice(openBlocks.indexOf(textIndex), 1);
        textIndex = null;
      }
      const blockIndex = nextIndex++;
      toolBlockIndex.set(ev.index, blockIndex);
      openBlocks.push(blockIndex);
      yield encodeSseJson(
        {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} },
        },
        "content_block_start",
      );
    } else if (ev.type === "tool-call-delta") {
      const blockIndex = toolBlockIndex.get(ev.index);
      if (blockIndex !== undefined) {
        yield encodeSseJson(
          {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: ev.argsDelta },
          },
          "content_block_delta",
        );
      }
    } else if (ev.type === "usage") {
      outputTokens = ev.usage.outputTokens;
      inputTokens = ev.usage.inputTokens;
    } else if (ev.type === "stop") {
      stopReason = neutralToAnthropicStop(ev.reason);
    }
  }

  for (const index of openBlocks) {
    yield encodeSseJson({ type: "content_block_stop", index }, "content_block_stop");
  }
  yield encodeSseJson(
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
    "message_delta",
  );
  yield encodeSseJson({ type: "message_stop" }, "message_stop");
}

// ----------------------------------------------------------------------------
// Upstream edge: NeutralRequest  →  Anthropic Messages body
// ----------------------------------------------------------------------------

function partsToAnthropicBlocks(parts: ContentPart[]): JsonObject[] {
  return parts.map((p) =>
    p.kind === "text"
      ? { type: "text", text: p.text }
      : {
          type: "image",
          source:
            p.source.type === "base64"
              ? { type: "base64", media_type: p.mediaType, data: p.source.data }
              : { type: "url", url: p.source.url },
        },
  );
}

export function neutralToAnthropicBody(
  req: NeutralRequest,
  upstreamModel: string,
  opts: UpstreamCallOptions,
): JsonObject {
  const messages: JsonObject[] = [];
  let userBuffer: JsonObject[] = [];
  const flush = (): void => {
    if (userBuffer.length > 0) {
      messages.push({ role: "user", content: userBuffer });
      userBuffer = [];
    }
  };
  for (const m of req.messages) {
    if (m.role === "user") {
      userBuffer.push(...partsToAnthropicBlocks(m.content));
    } else if (m.role === "tool") {
      userBuffer.push({
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: flattenText(m.content),
      });
    } else if (m.role === "assistant") {
      flush();
      const blocks: JsonObject[] = partsToAnthropicBlocks(m.content);
      if (m.toolCalls && m.toolCalls.length > 0) blocks.push(...toolCallsToBlocks(m.toolCalls));
      messages.push({ role: "assistant", content: blocks });
    }
  }
  flush();

  const body: JsonObject = {
    model: upstreamModel,
    messages,
    max_tokens: opts.maxTokens,
    stream: req.stream,
  };
  if (req.system && req.system.length > 0) {
    body.system = req.system.map((p) => ({ type: "text", text: flattenText([p]) }));
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop && req.stop.length > 0) body.stop_sequences = req.stop;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      input_schema: t.parameters,
      ...(t.description ? { description: t.description } : {}),
    }));
  }
  if (req.toolChoice) {
    body.tool_choice =
      typeof req.toolChoice === "string"
        ? { type: req.toolChoice === "required" ? "any" : req.toolChoice }
        : { type: "tool", name: req.toolChoice.name };
  }
  return body;
}

// ----------------------------------------------------------------------------
// Upstream edge: Anthropic response / stream  →  Neutral
// ----------------------------------------------------------------------------

export function anthropicResponseToNeutral(json: unknown, fallbackModel: string): NeutralResult {
  const obj = asObject(json);
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of getArray(obj, "content")) {
    const type = getString(block, "type");
    if (type === "text") content.push({ kind: "text", text: getString(block, "text") ?? "" });
    else if (type === "tool_use") {
      toolCalls.push({
        id: getString(block, "id") ?? "",
        name: getString(block, "name") ?? "",
        arguments: JSON.stringify(asObject(block).input ?? {}),
      });
    }
  }
  const usage = getObject(obj, "usage") ?? {};
  const cacheRead = getNumber(usage, "cache_read_input_tokens");
  const cacheWrite = getNumber(usage, "cache_creation_input_tokens");

  return {
    model: getString(obj, "model") ?? fallbackModel,
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason: anthropicStopToNeutral(getString(obj, "stop_reason")),
    usage: {
      inputTokens: getNumber(usage, "input_tokens") ?? 0,
      outputTokens: getNumber(usage, "output_tokens") ?? 0,
      ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    },
  };
}

export async function* anthropicStreamToNeutral(
  frames: AsyncIterable<{ event?: string; data: string }>,
  fallbackModel: string,
): AsyncGenerator<StreamEvent, void, unknown> {
  yield { type: "start", model: fallbackModel };
  const blockToToolOrdinal = new Map<number, number>();
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

    if (type === "content_block_start") {
      const index = getNumber(obj, "index") ?? 0;
      const block = getObject(obj, "content_block") ?? {};
      if (getString(block, "type") === "tool_use") {
        const ordinal = toolOrdinal++;
        blockToToolOrdinal.set(index, ordinal);
        yield {
          type: "tool-call-start",
          index: ordinal,
          id: getString(block, "id") ?? "",
          name: getString(block, "name") ?? "",
        };
      }
    } else if (type === "content_block_delta") {
      const index = getNumber(obj, "index") ?? 0;
      const delta = getObject(obj, "delta") ?? {};
      const deltaType = getString(delta, "type");
      if (deltaType === "text_delta") {
        yield { type: "text-delta", text: getString(delta, "text") ?? "" };
      } else if (deltaType === "input_json_delta") {
        const ordinal = blockToToolOrdinal.get(index) ?? 0;
        yield {
          type: "tool-call-delta",
          index: ordinal,
          argsDelta: getString(delta, "partial_json") ?? "",
        };
      }
    } else if (type === "message_delta") {
      const reason = getString(getObject(obj, "delta"), "stop_reason");
      if (reason) stop = { type: "stop", reason: anthropicStopToNeutral(reason) };
      const usage = getObject(obj, "usage");
      if (usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: getNumber(usage, "input_tokens") ?? 0,
            outputTokens: getNumber(usage, "output_tokens") ?? 0,
          },
        };
      }
    } else if (type === "message_stop") {
      break;
    }
  }
  yield stop;
}

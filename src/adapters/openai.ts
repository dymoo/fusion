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
import { chatCompletionId } from "../util/id.js";
import { parseDataUri, imagePartToUrl } from "./content.js";
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
import { neutralToOpenaiFinish, openaiFinishToNeutral } from "./mapping.js";

// ----------------------------------------------------------------------------
// Client edge: OpenAI Chat Completions request  →  NeutralRequest
// ----------------------------------------------------------------------------

function partsFromOpenaiContent(content: unknown): ContentPart[] {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  const parts: ContentPart[] = [];
  for (const raw of asArray(content)) {
    const type = getString(raw, "type");
    if (type === "text") {
      const text = getString(raw, "text") ?? "";
      parts.push({ kind: "text", text });
    } else if (type === "image_url") {
      const url = getString(getObject(raw, "image_url"), "url");
      if (!url) continue;
      const data = parseDataUri(url);
      parts.push(
        data
          ? {
              kind: "image",
              mediaType: data.mediaType,
              source: { type: "base64", data: data.data },
            }
          : { kind: "image", mediaType: "image/*", source: { type: "url", url } },
      );
    }
  }
  return parts;
}

function toolCallsFromOpenai(raw: unknown): ToolCall[] | undefined {
  const calls = asArray(raw);
  if (calls.length === 0) return undefined;
  const out: ToolCall[] = [];
  for (const call of calls) {
    const fn = getObject(call, "function");
    const name = getString(fn, "name");
    if (!name) continue;
    out.push({
      id: getString(call, "id") ?? "",
      name,
      arguments: getString(fn, "arguments") ?? "",
    });
  }
  return out.length > 0 ? out : undefined;
}

function toolChoiceFromOpenai(raw: unknown): ToolChoice | undefined {
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  if (isObject(raw)) {
    const name = getString(getObject(raw, "function"), "name");
    if (name) return { name };
  }
  return undefined;
}

function toolsFromOpenai(raw: unknown): ToolDef[] | undefined {
  const tools: ToolDef[] = [];
  for (const tool of asArray(raw)) {
    const fn = getObject(tool, "function");
    const name = getString(fn, "name");
    if (!name) continue;
    const description = getString(fn, "description");
    const parameters = getObject(fn, "parameters") ?? {};
    tools.push({ name, parameters, ...(description ? { description } : {}) });
  }
  return tools.length > 0 ? tools : undefined;
}

export function openaiRequestToNeutral(body: unknown, sessionId: string): NeutralRequest {
  const obj = asObject(body);
  const model = getString(obj, "model") ?? "fusion";
  const system: ContentPart[] = [];
  const messages: NeutralMessage[] = [];

  for (const raw of getArray(obj, "messages")) {
    const role = getString(raw, "role");
    if (role === "system" || role === "developer") {
      system.push(...partsFromOpenaiContent(asObject(raw).content));
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "tool",
        content: partsFromOpenaiContent(asObject(raw).content),
        toolCallId: getString(raw, "tool_call_id") ?? "",
      });
      continue;
    }
    if (role === "assistant") {
      const toolCalls = toolCallsFromOpenai(asObject(raw).tool_calls);
      messages.push({
        role: "assistant",
        content: partsFromOpenaiContent(asObject(raw).content),
        ...(toolCalls ? { toolCalls } : {}),
      });
      continue;
    }
    messages.push({ role: "user", content: partsFromOpenaiContent(asObject(raw).content) });
  }

  const maxTokens = getNumber(obj, "max_tokens") ?? getNumber(obj, "max_completion_tokens");
  const temperature = getNumber(obj, "temperature");
  const topP = getNumber(obj, "top_p");
  const stopRaw = obj.stop;
  const stop =
    typeof stopRaw === "string"
      ? [stopRaw]
      : asArray(stopRaw).filter((s): s is string => typeof s === "string");
  const tools = toolsFromOpenai(obj.tools);
  const toolChoice = toolChoiceFromOpenai(obj.tool_choice);

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

/** Parse Fusion route override from extra request fields. */
export function parseOpenaiRouteOverride(body: unknown): {
  mode?: "single" | "panel";
  panel?: string;
} {
  const obj = asObject(body);
  const route = getString(obj, "fusion_route");
  const panel = getString(obj, "panel");
  const out: { mode?: "single" | "panel"; panel?: string } = {};
  if (route === "single" || route === "panel") out.mode = route;
  if (panel) out.panel = panel;
  return out;
}

// ----------------------------------------------------------------------------
// Client edge: NeutralResult / StreamEvent  →  OpenAI response
// ----------------------------------------------------------------------------

export function neutralResultToOpenai(result: NeutralResult, modelEcho: string): JsonObject {
  const message: JsonObject = { role: "assistant", content: flattenText(result.content) || null };
  if (result.toolCalls && result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((tc) => ({
      id: tc.id || `call_${tc.name}`,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id: chatCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelEcho,
    choices: [{ index: 0, message, finish_reason: neutralToOpenaiFinish(result.stopReason) }],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
      ...(result.usage.cacheReadTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: result.usage.cacheReadTokens } }
        : {}),
    },
  };
}

/** Translate neutral stream events into OpenAI chat.completion.chunk SSE frames. */
export async function* neutralStreamToOpenai(
  events: AsyncIterable<StreamEvent>,
  modelEcho: string,
): AsyncGenerator<string, void, unknown> {
  const id = chatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model: modelEcho };
  let started = false;
  let finish = "stop";

  const chunk = (delta: JsonObject, finishReason: string | null): string => {
    const payload = { ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] };
    return `data: ${JSON.stringify(payload)}\n\n`;
  };

  for await (const ev of events) {
    if (ev.type === "start" && !started) {
      started = true;
      yield chunk({ role: "assistant", content: "" }, null);
    } else if (ev.type === "text-delta") {
      yield chunk({ content: ev.text }, null);
    } else if (ev.type === "tool-call-start") {
      yield chunk(
        {
          tool_calls: [
            {
              index: ev.index,
              id: ev.id,
              type: "function",
              function: { name: ev.name, arguments: "" },
            },
          ],
        },
        null,
      );
    } else if (ev.type === "tool-call-delta") {
      yield chunk(
        { tool_calls: [{ index: ev.index, function: { arguments: ev.argsDelta } }] },
        null,
      );
    } else if (ev.type === "stop") {
      finish = neutralToOpenaiFinish(ev.reason);
    } else if (ev.type === "error") {
      finish = "stop";
    }
  }
  yield chunk({}, finish);
  yield "data: [DONE]\n\n";
}

// ----------------------------------------------------------------------------
// Upstream edge: NeutralRequest  →  OpenAI Chat Completions body
// ----------------------------------------------------------------------------

function openaiContentFromParts(parts: ContentPart[]): string | JsonObject[] {
  const hasImage = parts.some((p) => p.kind === "image");
  if (!hasImage) return flattenText(parts);
  return parts.map((p) =>
    p.kind === "text"
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: imagePartToUrl(p) } },
  );
}

export function neutralToOpenaiBody(
  req: NeutralRequest,
  upstreamModel: string,
  opts: UpstreamCallOptions,
): JsonObject {
  const messages: JsonObject[] = [];
  if (req.system && req.system.length > 0) {
    messages.push({ role: "system", content: flattenText(req.system) });
  }
  for (const m of req.messages) {
    if (m.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: flattenText(m.content),
      });
      continue;
    }
    if (m.role === "assistant") {
      const msg: JsonObject = { role: "assistant", content: openaiContentFromParts(m.content) };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id || `call_${tc.name}`,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      messages.push(msg);
      continue;
    }
    messages.push({ role: m.role, content: openaiContentFromParts(m.content) });
  }

  const body: JsonObject = {
    model: upstreamModel,
    messages,
    max_tokens: opts.maxTokens,
    stream: req.stream,
  };
  if (req.stream) body.stream_options = { include_usage: true };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop && req.stop.length > 0) body.stop = req.stop;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        parameters: t.parameters,
        ...(t.description ? { description: t.description } : {}),
      },
    }));
  }
  if (req.toolChoice) {
    body.tool_choice =
      typeof req.toolChoice === "string"
        ? req.toolChoice
        : { type: "function", function: { name: req.toolChoice.name } };
  }
  if (opts.promptCacheKey) body.prompt_cache_key = opts.promptCacheKey;
  return body;
}

// ----------------------------------------------------------------------------
// Upstream edge: OpenAI response / stream  →  Neutral
// ----------------------------------------------------------------------------

export function openaiResponseToNeutral(json: unknown, fallbackModel: string): NeutralResult {
  const obj = asObject(json);
  const choice = asObject(getArray(obj, "choices")[0]);
  const message = getObject(choice, "message") ?? {};
  const content: ContentPart[] = [];
  const text = getString(message, "content");
  if (text) content.push({ kind: "text", text });
  const toolCalls = toolCallsFromOpenai(asObject(message).tool_calls);
  const usage = getObject(obj, "usage") ?? {};
  const cached = getNumber(getObject(usage, "prompt_tokens_details"), "cached_tokens");

  return {
    model: getString(obj, "model") ?? fallbackModel,
    content,
    ...(toolCalls ? { toolCalls } : {}),
    stopReason: openaiFinishToNeutral(getString(choice, "finish_reason")),
    usage: {
      inputTokens: getNumber(usage, "prompt_tokens") ?? 0,
      outputTokens: getNumber(usage, "completion_tokens") ?? 0,
      ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    },
  };
}

export async function* openaiStreamToNeutral(
  frames: AsyncIterable<{ data: string }>,
  fallbackModel: string,
): AsyncGenerator<StreamEvent, void, unknown> {
  yield { type: "start", model: fallbackModel };
  let stop: StreamEvent = { type: "stop", reason: "stop" };
  const toolIndexSeen = new Set<number>();

  for await (const frame of frames) {
    if (frame.data === "[DONE]") break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const obj = asObject(parsed);
    const choice = asObject(getArray(obj, "choices")[0]);
    const delta = getObject(choice, "delta") ?? {};
    const text = getString(delta, "content");
    if (text) yield { type: "text-delta", text };

    for (const call of getArray(delta, "tool_calls")) {
      const index = getNumber(call, "index") ?? 0;
      const fn = getObject(call, "function") ?? {};
      const name = getString(fn, "name");
      if (!toolIndexSeen.has(index) && name) {
        toolIndexSeen.add(index);
        yield { type: "tool-call-start", index, id: getString(call, "id") ?? "", name };
      }
      const argsDelta = getString(fn, "arguments");
      if (argsDelta) yield { type: "tool-call-delta", index, argsDelta };
    }

    const finish = getString(choice, "finish_reason");
    if (finish) stop = { type: "stop", reason: openaiFinishToNeutral(finish) };

    const usage = getObject(obj, "usage");
    if (usage) {
      yield {
        type: "usage",
        usage: {
          inputTokens: getNumber(usage, "prompt_tokens") ?? 0,
          outputTokens: getNumber(usage, "completion_tokens") ?? 0,
        },
      };
    }
  }
  yield stop;
}

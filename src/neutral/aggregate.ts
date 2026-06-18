import type { ContentPart, NeutralResult, StreamEvent, ToolCall } from "./types.js";

/**
 * Fold a neutral stream into a single NeutralResult. Used when a streaming-only
 * upstream (e.g. the codex backend) must answer a non-streaming `complete()`
 * call, and when buffering panel members before the judge.
 */
export function aggregateStreamEvents(events: StreamEvent[], fallbackModel: string): NeutralResult {
  let model = fallbackModel;
  let text = "";
  let stopReason: NeutralResult["stopReason"] = "stop";
  let usage: NeutralResult["usage"] = { inputTokens: 0, outputTokens: 0 };
  const toolByIndex = new Map<number, { id: string; name: string; args: string }>();

  for (const ev of events) {
    switch (ev.type) {
      case "start":
        model = ev.model || model;
        break;
      case "text-delta":
        text += ev.text;
        break;
      case "tool-call-start":
        toolByIndex.set(ev.index, { id: ev.id, name: ev.name, args: "" });
        break;
      case "tool-call-delta": {
        const entry = toolByIndex.get(ev.index);
        if (entry) entry.args += ev.argsDelta;
        break;
      }
      case "usage":
        usage = ev.usage;
        break;
      case "stop":
        stopReason = ev.reason;
        break;
      case "error":
        stopReason = "error";
        break;
    }
  }

  const content: ContentPart[] = text ? [{ kind: "text", text }] : [];
  const toolCalls: ToolCall[] = [...toolByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ id: t.id, name: t.name, arguments: t.args }));

  return {
    model,
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason,
    usage,
  };
}

export async function collectStream(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

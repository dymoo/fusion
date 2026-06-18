/** Server-Sent Events helpers: encode frames we emit, decode frames we read. */

export interface SseFrame {
  event?: string;
  data: string;
}

/** Encode a single SSE frame (optionally named). Data is emitted as one `data:` line. */
export function encodeSse(data: string, event?: string): string {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${data}`);
  return lines.join("\n") + "\n\n";
}

/** Encode a JSON payload as an SSE frame. */
export function encodeSseJson(payload: unknown, event?: string): string {
  return encodeSse(JSON.stringify(payload), event);
}

/**
 * Parse an upstream SSE byte stream into frames. Handles multi-line `data:`
 * fields and CRLF/LF. Yields one frame per blank-line-delimited block.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = parseBlock(block);
        if (frame) yield frame;
        sep = buffer.indexOf("\n\n");
      }
    }
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return event !== undefined
    ? { event, data: dataLines.join("\n") }
    : { data: dataLines.join("\n") };
}

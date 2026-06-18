import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "fusion_error",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export async function readJsonBody(
  req: IncomingMessage,
  limitBytes = 32 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) throw new AppError(413, "Request body too large");
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "Invalid JSON body");
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(body);
}

export function startSse(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...extraHeaders,
  });
}

/** Constant-time bearer/x-api-key check. */
export function authorized(
  headers: Record<string, string | undefined>,
  expected: string | undefined,
): boolean {
  if (!expected) return true;
  const bearer = headers["authorization"]?.replace(/^Bearer\s+/i, "");
  const apiKey = headers["x-api-key"];
  const provided = bearer ?? apiKey ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Normalize Node's header bag to a flat string record (last value wins). */
export function flatHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[v.length - 1] : v;
  }
  return out;
}

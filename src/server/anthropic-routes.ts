import type { IncomingMessage, ServerResponse } from "node:http";

import {
  anthropicRequestToNeutral,
  neutralResultToAnthropic,
  neutralStreamToAnthropic,
} from "../adapters/anthropic.js";
import { flattenText, hasImages, type NeutralRequest } from "../neutral/types.js";
import { requestId } from "../util/id.js";
import { logger } from "../util/logger.js";
import { deriveSessionId } from "../util/session-id.js";
import { type App, fusionRouteHeader } from "./app.js";
import { parseDepth, parseOverrideHeaders } from "./request-context.js";
import { flatHeaders, readJsonBody, sendJson, startSse } from "./respond.js";

function stableSeed(req: NeutralRequest): string {
  const sys = flattenText(req.system ?? []);
  const firstUser = req.messages.find((m) => m.role === "user");
  return `${sys} ${firstUser ? flattenText(firstUser.content) : ""}`;
}

export async function handleAnthropicMessages(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const started = Date.now();
  const headers = flatHeaders(req);
  const body = await readJsonBody(req);
  const depth = parseDepth(headers);
  const override = parseOverrideHeaders(headers);

  const neutral = anthropicRequestToNeutral(body, "");
  neutral.sessionId = deriveSessionId(headers, stableSeed(neutral));
  const log = logger.child({
    reqId: requestId(),
    sessionId: neutral.sessionId,
    surface: "anthropic",
  });
  log.info("request", {
    model: neutral.model,
    stream: neutral.stream,
    messages: neutral.messages.length,
    tools: neutral.tools?.length ?? 0,
    images: hasImages(neutral),
    depth,
    override,
  });

  const outcome = await app.route(neutral, override, depth, signal, log);
  const routeHeader = fusionRouteHeader(outcome.meta);

  if (outcome.mode === "stream") {
    startSse(res, { "x-fusion-route": routeHeader });
    for await (const chunk of neutralStreamToAnthropic(outcome.stream, neutral.model)) {
      res.write(chunk);
    }
    res.end();
    log.info("response done", { stream: true, totalMs: Date.now() - started });
    return;
  }
  sendJson(res, 200, neutralResultToAnthropic(outcome.result, neutral.model), {
    "x-fusion-route": routeHeader,
  });
  log.info("response done", { stream: false, totalMs: Date.now() - started });
}

export async function handleAnthropicCountTokens(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const headers = flatHeaders(req);
  const body = await readJsonBody(req);
  const neutral = anthropicRequestToNeutral(body, "");
  neutral.sessionId = deriveSessionId(headers, stableSeed(neutral));
  let chars = 0;
  for (const p of neutral.system ?? []) chars += p.kind === "text" ? p.text.length : 0;
  for (const m of neutral.messages)
    for (const p of m.content) chars += p.kind === "text" ? p.text.length : 0;
  sendJson(res, 200, { input_tokens: Math.ceil(chars / 4) });
}

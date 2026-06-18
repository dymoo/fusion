import type { IncomingMessage, ServerResponse } from "node:http";

import {
  anthropicRequestToNeutral,
  neutralResultToAnthropic,
  neutralStreamToAnthropic,
} from "../adapters/anthropic.js";
import { flattenText, type NeutralRequest } from "../neutral/types.js";
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
  const headers = flatHeaders(req);
  const body = await readJsonBody(req);
  const depth = parseDepth(headers);
  const override = parseOverrideHeaders(headers);

  const neutral = anthropicRequestToNeutral(body, "");
  neutral.sessionId = deriveSessionId(headers, stableSeed(neutral));

  const outcome = await app.route(neutral, override, depth, signal);
  const routeHeader = fusionRouteHeader(outcome.meta);

  if (outcome.mode === "stream") {
    startSse(res, { "x-fusion-route": routeHeader });
    for await (const chunk of neutralStreamToAnthropic(outcome.stream, neutral.model)) {
      res.write(chunk);
    }
    res.end();
    return;
  }
  sendJson(res, 200, neutralResultToAnthropic(outcome.result, neutral.model), {
    "x-fusion-route": routeHeader,
  });
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

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { CodexAuthError } from "../auth/codex.js";
import type { FusionConfig } from "../config/schema.js";
import { ImageRouteError } from "../panel/orchestrator.js";
import { ClassifierUnavailableError } from "../routing/classifier.js";
import { RingExhaustedError } from "../routing/failover.js";
import { logger } from "../util/logger.js";
import { packageVersion } from "../util/version.js";
import { App } from "./app.js";
import { handleAnthropicCountTokens, handleAnthropicMessages } from "./anthropic-routes.js";
import { anthropicModelsList, openaiModelsList } from "./models.js";
import { handleOpenaiChat } from "./openai-routes.js";
import { AppError, authorized, flatHeaders, sendJson } from "./respond.js";

type Surface = "openai" | "anthropic";

function surfaceForPath(path: string): Surface {
  return path.startsWith("/v1/messages") ? "anthropic" : "openai";
}

function statusFor(err: unknown): number {
  if (err instanceof AppError) return err.status;
  if (err instanceof ImageRouteError) return 400;
  if (err instanceof RingExhaustedError) return 502;
  if (err instanceof CodexAuthError) return 401;
  if (err instanceof ClassifierUnavailableError) return 503;
  return 500;
}

function sendError(res: ServerResponse, surface: Surface, err: unknown): void {
  const status = statusFor(err);
  const message = err instanceof Error ? err.message : String(err);
  if (res.headersSent) {
    res.end();
    return;
  }
  if (surface === "anthropic") {
    sendJson(res, status, { type: "error", error: { type: anthropicErrorType(status), message } });
  } else {
    sendJson(res, status, { error: { message, type: openaiErrorType(status), code: status } });
  }
}

function openaiErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

function anthropicErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status === 502) return "api_error";
  return "api_error";
}

export function createServer(app: App): Server {
  const config = app.config;
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(app, config, req, res);
  });
}

async function handle(
  app: App,
  config: FusionConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const headers = flatHeaders(req);
  const surface = surfaceForPath(path);

  // Health is unauthenticated so daemon `status` probes work without a key.
  if (method === "GET" && path === "/health") {
    sendJson(res, 200, {
      status: "ok",
      version: packageVersion(),
      mode: app.config.routing.mode,
      upstreams: [...app.upstreams.keys()],
      orchestrator: [...app.state.orchestrator.members],
      panels: [...app.state.panels.keys()],
      ...(app.config.routing.mode === "smart" ? { classifier: app.classifier.ready() } : {}),
      floor: app.modelFloor(),
    });
    return;
  }

  if (!authorized(headers, config.server.authKey)) {
    sendError(res, surface, new AppError(401, "Missing or invalid API key"));
    return;
  }

  // Abort upstream work only if the client disconnects before we finish
  // responding. (Listening on the request stream's "close" would fire as soon
  // as the request body is fully read, cancelling the upstream prematurely.)
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });

  try {
    if (method === "GET" && path === "/v1/models") {
      const isAnthropic =
        headers["anthropic-version"] !== undefined || headers["x-api-key"] !== undefined;
      sendJson(res, 200, isAnthropic ? anthropicModelsList(app) : openaiModelsList(app));
      return;
    }
    if (method === "POST" && path === "/v1/chat/completions") {
      await handleOpenaiChat(app, req, res, ac.signal);
      return;
    }
    if (method === "POST" && path === "/v1/messages") {
      await handleAnthropicMessages(app, req, res, ac.signal);
      return;
    }
    if (method === "POST" && path === "/v1/messages/count_tokens") {
      await handleAnthropicCountTokens(req, res);
      return;
    }
    sendError(res, surface, new AppError(404, `Not found: ${method} ${path}`));
  } catch (err) {
    logger.error("request failed", { path, error: (err as Error).message });
    sendError(res, surface, err);
  }
}

export interface RunningServer {
  server: Server;
  app: App;
  port: number;
  host: string;
}

/** Build the app, initialize capabilities, and start listening. */
export async function startServer(
  config: FusionConfig,
  portOverride?: number,
): Promise<RunningServer> {
  const app = new App(config);
  await app.init();
  const server = createServer(app);
  const port = portOverride ?? config.server.port;
  const host = config.server.host;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  logger.info("fusion listening", { host, port, upstreams: [...app.upstreams.keys()] });
  return { server, app, port, host };
}

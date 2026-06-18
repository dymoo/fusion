import { neutralToResponsesBody, responsesStreamToNeutral } from "../adapters/responses.js";
import { CodexAuth, CODEX_RESPONSES_URL } from "../auth/codex.js";
import { readCodexModelDescriptors } from "../capabilities/sources/codex.js";
import type { ModelDescriptor } from "../capabilities/types.js";
import type { UpstreamConfig } from "../config/schema.js";
import { aggregateStreamEvents, collectStream } from "../neutral/aggregate.js";
import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import { parseSseStream } from "../util/sse.js";
import { type JsonObject } from "../adapters/json.js";
import { sendRequest } from "./base.js";
import type { ProviderKind, Upstream, UpstreamCallOptions } from "./types.js";
import { UpstreamError } from "./types.js";

const ORIGINATOR = process.env.FUSION_CODEX_ORIGINATOR ?? "codex_cli_rs";
const USER_AGENT = `fusion (${process.platform}; ${process.arch})`;

/** Client for the ChatGPT/Codex backend (OpenAI Responses API over OAuth). */
export class CodexUpstream implements Upstream {
  readonly id: string;
  readonly kind: ProviderKind = "codex";
  private readonly auth: CodexAuth;
  private readonly timeoutMs: number;
  private readonly configuredModels: string[] | undefined;

  constructor(config: UpstreamConfig, auth?: CodexAuth) {
    this.id = config.id;
    this.auth = auth ?? new CodexAuth();
    this.timeoutMs = config.requestTimeoutMs;
    this.configuredModels = config.models;
  }

  private modelFor(req: NeutralRequest): string {
    return this.configuredModels?.[0] ?? req.model;
  }

  private async headers(forceRefresh: boolean): Promise<Record<string, string>> {
    const cred = forceRefresh ? await this.auth.forceRefresh() : await this.auth.getCredential();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cred.accessToken}`,
      originator: ORIGINATOR,
      "User-Agent": USER_AGENT,
    };
    if (cred.accountId) headers["ChatGPT-Account-Id"] = cred.accountId;
    return headers;
  }

  private buildBody(req: NeutralRequest, model: string, opts: UpstreamCallOptions): JsonObject {
    const body = neutralToResponsesBody(req, model, opts);
    // The codex backend manages its own output budget; sending max_output_tokens
    // is rejected/ignored, mirroring opencode's behaviour for ChatGPT OAuth.
    delete body["max_output_tokens"];
    return body;
  }

  /** Open a streaming Responses request, refreshing + retrying once on 401. */
  private async open(
    req: NeutralRequest,
    model: string,
    opts: UpstreamCallOptions,
  ): Promise<Response> {
    const body = JSON.stringify(this.buildBody({ ...req, stream: true }, model, opts));
    const headers: Record<string, string> = {
      ...(await this.headers(false)),
      session_id: req.sessionId,
      "x-fusion-depth": String(opts.depth),
    };
    try {
      return await sendRequest(
        this.id,
        CODEX_RESPONSES_URL,
        { method: "POST", headers, body, timeoutMs: this.timeoutMs },
        opts.signal,
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        const retryHeaders: Record<string, string> = {
          ...(await this.headers(true)),
          session_id: req.sessionId,
          "x-fusion-depth": String(opts.depth),
        };
        return sendRequest(
          this.id,
          CODEX_RESPONSES_URL,
          { method: "POST", headers: retryHeaders, body, timeoutMs: this.timeoutMs },
          opts.signal,
        );
      }
      throw err;
    }
  }

  async *stream(req: NeutralRequest, opts: UpstreamCallOptions): AsyncIterable<StreamEvent> {
    const model = this.modelFor(req);
    const res = await this.open(req, model, opts);
    if (!res.body) throw new UpstreamError(this.id, null, true, null, "empty stream body");
    yield* responsesStreamToNeutral(parseSseStream(res.body), model);
  }

  async complete(req: NeutralRequest, opts: UpstreamCallOptions): Promise<NeutralResult> {
    const model = this.modelFor(req);
    const events = await collectStream(this.stream(req, opts));
    return aggregateStreamEvents(events, model);
  }

  discover(): Promise<ModelDescriptor[]> {
    return Promise.resolve(readCodexModelDescriptors(this.id, this.configuredModels));
  }
}

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CapabilityResolver } from "../capabilities/resolver.js";
import type { Capabilities, ModelDescriptor } from "../capabilities/types.js";
import { fusionConfigSchema, routingConfigSchema } from "../config/schema.js";
import type { NeutralRequest } from "../neutral/types.js";
import { selectCandidates } from "../routing/selection.js";
import type { Upstream } from "../upstreams/types.js";

function mock(id: string, caps: Capabilities): Upstream {
  return {
    id,
    kind: "openai-compatible",
    complete: () => Promise.reject(new Error("unused")),
    async *stream() {},
    discover: (): Promise<ModelDescriptor[]> =>
      Promise.resolve([
        { upstreamId: id, modelId: id, capabilities: caps, source: "provider-native" },
      ]),
  };
}

const vision: Capabilities = {
  tools: true,
  modalities: ["text", "image"],
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
};
const textOnly: Capabilities = {
  tools: true,
  modalities: ["text"],
  contextWindow: 32_000,
  maxOutputTokens: 8_192,
};

function config() {
  return fusionConfigSchema.parse({
    upstreams: [
      { id: "vision", type: "openai-compatible", baseURL: "http://v/v1", models: ["v"] },
      { id: "text", type: "openai-compatible", baseURL: "http://t/v1", models: ["t"] },
    ],
    pools: { orchestrator: ["vision", "text"] },
  });
}

async function resolverWith(upstreams: Map<string, Upstream>): Promise<CapabilityResolver> {
  const r = new CapabilityResolver(upstreams, config());
  await r.refresh();
  return r;
}

function imageReq(): NeutralRequest {
  return {
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { kind: "image", mediaType: "image/png", source: { type: "base64", data: "AA" } },
        ],
      },
    ],
    stream: false,
    sessionId: "s",
  };
}

function textReq(): NeutralRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    stream: false,
    sessionId: "s",
  };
}

describe("selectCandidates image routing", () => {
  it("excludes non-vision models when the request has an image", async () => {
    const r = await resolverWith(
      new Map([
        ["vision", mock("vision", vision)],
        ["text", mock("text", textOnly)],
      ]),
    );
    const sel = selectCandidates(["vision", "text"], imageReq(), r, routingConfigSchema.parse({}));
    assert.deepEqual([...sel.excluded], ["text"]);
    assert.equal(sel.error, undefined);
  });

  it("does not exclude anything for a text-only request", async () => {
    const r = await resolverWith(
      new Map([
        ["vision", mock("vision", vision)],
        ["text", mock("text", textOnly)],
      ]),
    );
    const sel = selectCandidates(["vision", "text"], textReq(), r, routingConfigSchema.parse({}));
    assert.equal(sel.excluded.size, 0);
  });

  it("errors when an image is sent but no vision model exists (imageFallback=error)", async () => {
    const r = await resolverWith(new Map([["text", mock("text", textOnly)]]));
    const sel = selectCandidates(
      ["text"],
      imageReq(),
      r,
      routingConfigSchema.parse({ imageFallback: "error" }),
    );
    assert.ok(sel.error);
  });

  it("strips images when imageFallback=strip and no vision model exists", async () => {
    const r = await resolverWith(new Map([["text", mock("text", textOnly)]]));
    const sel = selectCandidates(
      ["text"],
      imageReq(),
      r,
      routingConfigSchema.parse({ imageFallback: "strip" }),
    );
    assert.equal(sel.error, undefined);
    assert.equal(sel.stripImages, true);
  });
});

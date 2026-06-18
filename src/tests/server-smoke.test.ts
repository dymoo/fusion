import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { MockAgent, setGlobalDispatcher } from "undici";

import { fusionConfigSchema } from "../config/schema.js";
import type { Embedder } from "../embeddings/embedder.js";
import { App } from "../server/app.js";
import { createServer, startServer, type RunningServer } from "../server/http.js";
import { ComplexityClassifier } from "../routing/classifier.js";

describe("server smoke (mocked upstreams)", () => {
  let running: RunningServer;
  let agent: MockAgent;
  let base: string;

  before(async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect((host) => host.includes("127.0.0.1") || host.includes("localhost"));
    setGlobalDispatcher(agent);
    const pool = agent.get("http://upstream.test");
    pool
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, {
        model: "mock",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      })
      .persist();

    const config = fusionConfigSchema.parse({
      server: { host: "127.0.0.1", port: 8787 },
      upstreams: [
        {
          id: "u",
          type: "openai-compatible",
          baseURL: "http://upstream.test/v1",
          models: ["mock-a"],
        },
        {
          id: "u2",
          type: "openai-compatible",
          baseURL: "http://upstream.test/v1",
          models: ["mock-b"],
        },
      ],
      pools: { orchestrator: ["u"], panel: { default: ["u", "u2"] } },
      routing: { mode: "single" }, // avoid loading the ONNX model in this suite
    });
    running = await startServer(config, 0);
    const port = (running.server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    running.app.shutdown();
    running.server.close();
    await agent.close();
  });

  it("serves /health", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; orchestrator: string[] };
    assert.equal(body.status, "ok");
    assert.deepEqual(body.orchestrator, ["u"]);
  });

  it("serves /v1/models", async () => {
    const res = await fetch(`${base}/v1/models`);
    const body = (await res.json()) as { data: { id: string }[] };
    assert.ok(body.data.some((m) => m.id === "fusion"));
  });

  it("routes a single chat completion and reports the route header", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fusion", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("x-fusion-route") ?? "", /mode=single/);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0]!.message.content, "hi there");
  });

  it("fuses every request when forced via x-fusion-route: all", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fusion-route": "all" },
      body: JSON.stringify({
        model: "fusion",
        messages: [{ role: "user", content: "design a system" }],
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("x-fusion-route") ?? "", /mode=panel/);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0]!.message.content, "hi there");
  });

  it("serves an Anthropic message", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "fusion",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; content: { type: string; text: string }[] };
    assert.equal(body.type, "message");
    assert.equal(body.content[0]!.text, "hi there");
  });
});

describe("server smoke — smart mode (stub embedder, no ONNX)", () => {
  let server: ReturnType<typeof createServer>;
  let app: App;
  let agent: MockAgent;
  let base: string;

  before(async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect((host) => host.includes("127.0.0.1") || host.includes("localhost"));
    setGlobalDispatcher(agent);
    agent
      .get("http://upstream.test")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, {
        model: "mock",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      })
      .persist();

    const config = fusionConfigSchema.parse({
      server: { host: "127.0.0.1", port: 8788 },
      upstreams: [
        {
          id: "fast",
          type: "openai-compatible",
          baseURL: "http://upstream.test/v1",
          models: ["a"],
        },
        { id: "big", type: "openai-compatible", baseURL: "http://upstream.test/v1", models: ["b"] },
      ],
      pools: {
        orchestrator: ["fast", "big"],
        compact: ["fast"],
        regular: ["fast", "big"],
        panel: { default: ["fast", "big"] },
      },
      routing: { mode: "smart" },
    });

    // Deterministic stub: distinct directions for plan-harness, compact-harness,
    // and everything else, so a normal query trips neither harness detector and
    // lands on a tier via embedding argmax. No ONNX model is loaded.
    const stub: Embedder = {
      id: "stub",
      warmup: () => Promise.resolve(),
      embed: (texts) =>
        Promise.resolve(
          texts.map((t) =>
            /plan mode|exitplanmode|must not make/i.test(t)
              ? [0, 0, 1, 0]
              : /summary of the conversation|primary request|pending tasks/i.test(t)
                ? [0, 0, 0, 1]
                : [1, 0, 0, 0],
          ),
        ),
    };
    app = new App(config, new ComplexityClassifier(stub, config.routing.smart));
    await app.init();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    app.shutdown();
    server.close();
    await agent.close();
  });

  it("smart mode classifies and reports the tier in the route header", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fusion",
        messages: [{ role: "user", content: "implement a parser" }],
      }),
    });
    assert.equal(res.status, 200);
    const header = res.headers.get("x-fusion-route") ?? "";
    assert.match(header, /tier=/);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0]!.message.content, "hi there");
  });
});

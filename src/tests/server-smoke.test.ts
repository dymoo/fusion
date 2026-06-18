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

describe("server smoke — tool requests never panel (agentic multi-turn)", () => {
  let running: RunningServer;
  let agent: MockAgent;
  let base: string;

  before(async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect((host) => host.includes("127.0.0.1") || host.includes("localhost"));
    setGlobalDispatcher(agent);
    // Upstream returns a tool call (the thing a panel would otherwise drop).
    agent
      .get("http://upstream.test")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, {
        model: "mock",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"NYC"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      })
      .persist();

    const config = fusionConfigSchema.parse({
      server: { host: "127.0.0.1", port: 8789 },
      upstreams: [
        { id: "u", type: "openai-compatible", baseURL: "http://upstream.test/v1", models: ["a"] },
        { id: "u2", type: "openai-compatible", baseURL: "http://upstream.test/v1", models: ["b"] },
      ],
      pools: { orchestrator: ["u", "u2"], panel: { default: ["u", "u2"] } },
      routing: { mode: "single" }, // no ONNX; the invariant is mode-independent
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

  it("downgrades x-fusion-route: all to single when tools are present, and tool_use survives", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-fusion-route": "all", // would panel — but tools force single
      },
      body: JSON.stringify({
        model: "fusion",
        max_tokens: 100,
        tools: [
          {
            name: "get_weather",
            description: "",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        messages: [{ role: "user", content: "what's the weather in NYC?" }],
      }),
    });
    assert.equal(res.status, 200);
    // Routed single (not panel) despite the `all` override, because tools are present.
    assert.match(res.headers.get("x-fusion-route") ?? "", /mode=single/);
    const body = (await res.json()) as {
      stop_reason: string;
      content: { type: string; name?: string; input?: Record<string, unknown> }[];
    };
    // The tool call survives the round-trip to the Anthropic client → agent can loop.
    const toolUse = body.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse, "expected a tool_use content block");
    assert.equal(toolUse.name, "get_weather");
    assert.deepEqual(toolUse.input, { city: "NYC" });
    assert.equal(body.stop_reason, "tool_use");
  });
});

describe("server smoke — council-then-act (hard agentic turn)", () => {
  let server: ReturnType<typeof createServer>;
  let app: App;
  let agent: MockAgent;
  let base: string;

  before(async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect((host) => host.includes("127.0.0.1") || host.includes("localhost"));
    setGlobalDispatcher(agent);
    // Advisors (advisor.test) deliberate as text; the actor (actor.test) returns a tool call.
    agent
      .get("http://advisor.test")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, {
        model: "adv",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "I recommend calling get_weather for NYC." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      })
      .persist();
    agent
      .get("http://actor.test")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, {
        model: "act",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"NYC"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      })
      .persist();

    const config = fusionConfigSchema.parse({
      server: { host: "127.0.0.1", port: 8790 },
      upstreams: [
        {
          id: "actor",
          type: "openai-compatible",
          baseURL: "http://actor.test/v1",
          models: ["act"],
        },
        {
          id: "adv1",
          type: "openai-compatible",
          baseURL: "http://advisor.test/v1",
          models: ["a1"],
        },
        {
          id: "adv2",
          type: "openai-compatible",
          baseURL: "http://advisor.test/v1",
          models: ["a2"],
        },
      ],
      pools: {
        orchestrator: ["actor", "adv1", "adv2"],
        actor: ["actor"],
        panel: { default: ["actor", "adv1", "adv2"], council: ["adv1", "adv2"] },
      },
      routing: {
        mode: "smart",
        forceSingleWhenTools: true,
        council: { enabled: true, panel: "council", trigger: "plan", synthesize: false },
      },
    });

    // Stub embedder: 5 dims [compactTier, regularTier, planTier, harnessPlan, harnessCompact].
    // "design/architecture" text and the plan anchors → planTier, so the gate convenes.
    const stub: Embedder = {
      id: "stub",
      warmup: () => Promise.resolve(),
      embed: (texts) =>
        Promise.resolve(
          texts.map((t) => {
            const s = t.toLowerCase();
            if (/plan mode|exitplanmode|must not make/.test(s)) return [0, 0, 0, 1, 0];
            if (/summary of the conversation|primary request|pending tasks/.test(s))
              return [0, 0, 0, 0, 1];
            if (/design|architect|refactor|migrat|root cause|implementation plan/.test(s))
              return [0, 0, 1, 0, 0];
            if (/typo|rename|format|bump/.test(s)) return [1, 0, 0, 0, 0];
            if (/implement|parser|handler|unit test|endpoint/.test(s)) return [0, 1, 0, 0, 0];
            return [0.1, 0.1, 0.1, 0.1, 0.1];
          }),
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

  it("convenes the council on a hard tool turn; actor's tool_use survives + header shows actor/council", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "fusion",
        max_tokens: 100,
        tools: [
          {
            name: "get_weather",
            description: "",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        messages: [
          { role: "user", content: "design the architecture for a weather service, then start it" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const header = res.headers.get("x-fusion-route") ?? "";
    assert.match(header, /actor=actor/);
    assert.match(header, /council=/);
    assert.ok(header.includes("adv1") && header.includes("adv2"), `advisors missing: ${header}`);
    const body = (await res.json()) as {
      stop_reason: string;
      content: { type: string; name?: string; input?: Record<string, unknown> }[];
    };
    const toolUse = body.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse, "expected the actor's tool_use to reach the client");
    assert.equal(toolUse.name, "get_weather");
    assert.equal(body.stop_reason, "tool_use");
  });
});

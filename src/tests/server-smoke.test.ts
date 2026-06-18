import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { MockAgent, setGlobalDispatcher } from "undici";

import { fusionConfigSchema } from "../config/schema.js";
import { startServer, type RunningServer } from "../server/http.js";

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
    assert.ok(body.data.some((m) => m.id === "fusion/coder"));
  });

  it("routes a single chat completion and reports the route header", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fusion/coder", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("x-fusion-route") ?? "", /mode=single/);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0]!.message.content, "hi there");
  });

  it("runs a panel when forced via x-fusion-route header", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fusion-route": "panel" },
      body: JSON.stringify({
        model: "fusion/coder",
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
        model: "claude-fusion",
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

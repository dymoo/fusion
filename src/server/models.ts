import type { App } from "./app.js";
import { VIRTUAL_MODELS } from "./app.js";

/** OpenAI-style `GET /v1/models` payload, advertising the floor capabilities. */
export function openaiModelsList(app: App): unknown {
  const floor = app.modelFloor();
  const created = 1700000000;
  return {
    object: "list",
    data: VIRTUAL_MODELS.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "fusion",
      fusion_capabilities: floor,
    })),
  };
}

/** Anthropic-style `GET /v1/models` payload (Claude Code gateway discovery). */
export function anthropicModelsList(app: App): unknown {
  const floor = app.modelFloor();
  return {
    data: VIRTUAL_MODELS.map((id) => ({
      type: "model",
      id,
      display_name: id,
      created_at: "2024-01-01T00:00:00Z",
      fusion_capabilities: floor,
    })),
    has_more: false,
    first_id: VIRTUAL_MODELS[0],
    last_id: VIRTUAL_MODELS[VIRTUAL_MODELS.length - 1],
  };
}

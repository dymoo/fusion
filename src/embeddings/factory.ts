import type { EmbeddingsConfig } from "../config/schema.js";
import type { Embedder, EmbedDevice } from "./embedder.js";
import { TransformersEmbedder } from "./embedder.js";

const DEVICES = new Set<EmbedDevice>([
  "auto",
  "cpu",
  "gpu",
  "cuda",
  "dml",
  "webgpu",
  "wasm",
  "webnn",
]);

function resolveDevice(): EmbedDevice {
  const raw = process.env.FUSION_EMBED_DEVICE?.trim() as EmbedDevice | undefined;
  return raw && DEVICES.has(raw) ? raw : "auto";
}

/** Build the in-process ONNX embedder (env overrides win). Uses GPU if available. */
export function buildEmbedder(cfg: EmbeddingsConfig): Embedder {
  const model = process.env.FUSION_EMBED_MODEL?.trim() || cfg.model;
  const dtype = (process.env.FUSION_EMBED_DTYPE?.trim() as EmbeddingsConfig["dtype"]) || cfg.dtype;
  return new TransformersEmbedder(model, dtype, resolveDevice());
}

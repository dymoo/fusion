import type { FeatureExtractionPipeline } from "@huggingface/transformers";

import type { EmbeddingsConfig } from "../config/schema.js";
import { logger } from "../util/logger.js";

/** A text → vector embedder. Implementations may load lazily. */
export interface Embedder {
  readonly id: string;
  /** Returns one unit-normalized vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
  /** Optionally pre-load the model so the first real call isn't slow. */
  warmup(): Promise<void>;
}

type Dtype = EmbeddingsConfig["dtype"];

/**
 * In-process embedder via @huggingface/transformers (ONNX). The model is
 * lazy-loaded on first use (and via `warmup()`), so a failure to load degrades
 * to the classifier's heuristic fallback instead of blocking startup.
 */
/** Hardware device for ONNX inference. "auto" picks GPU/CoreML/CUDA if available, else CPU. */
export type EmbedDevice = "auto" | "cpu" | "gpu" | "cuda" | "dml" | "webgpu" | "wasm" | "webnn";

export class TransformersEmbedder implements Embedder {
  readonly id: string;
  private extractor: FeatureExtractionPipeline | null = null;
  private loading: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    private readonly model: string,
    private readonly dtype: Dtype,
    private readonly device: EmbedDevice = "auto",
  ) {
    this.id = `transformers:${model}:${dtype}:${device}`;
  }

  private load(): Promise<FeatureExtractionPipeline> {
    if (this.extractor) return Promise.resolve(this.extractor);
    this.loading ??= (async () => {
      const started = Date.now();
      const { pipeline, env } = await import("@huggingface/transformers");
      const cacheDir = process.env.FUSION_EMBED_CACHE?.trim();
      if (cacheDir) env.cacheDir = cacheDir;
      // device:"auto" uses the best available execution provider (GPU/CoreML/CUDA),
      // transparently falling back to multi-threaded CPU when no accelerator exists.
      const extractor = await pipeline("feature-extraction", this.model, {
        dtype: this.dtype,
        device: this.device,
      });
      this.extractor = extractor;
      logger.info("embedder loaded", {
        model: this.model,
        dtype: this.dtype,
        device: this.device,
        ms: Date.now() - started,
      });
      return extractor;
    })();
    return this.loading;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.load();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist() as number[][];
  }

  async warmup(): Promise<void> {
    await this.embed(["warmup"]);
  }
}

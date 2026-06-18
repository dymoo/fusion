import { readFileSync } from "node:fs";

import { asArray, getArray, getNumber, getString } from "../../adapters/json.js";
import { codexModelsCacheFile } from "../../config/paths.js";
import { type Capabilities, type ModelDescriptor } from "../types.js";

const CODEX_MAX_OUTPUT = 128_000;

/**
 * Read codex's local capability cache (`~/.codex/models_cache.json`) and turn
 * each model into a descriptor. Falls back gracefully if the file is absent.
 */
export function readCodexModelDescriptors(
  upstreamId: string,
  configuredModels: string[] | undefined,
): ModelDescriptor[] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(codexModelsCacheFile(), "utf8"));
  } catch {
    json = null;
  }
  const fromCache = new Map<string, Capabilities>();
  for (const model of getArray(json, "models")) {
    const slug = getString(model, "slug");
    if (!slug) continue;
    const modalities = asArray((model as { input_modalities?: unknown }).input_modalities).filter(
      (m): m is string => typeof m === "string",
    );
    const context =
      getNumber(model, "context_window") ?? getNumber(model, "max_context_window") ?? 256_000;
    fromCache.set(slug, {
      tools: true,
      modalities: modalities.includes("image") ? ["text", "image"] : ["text"],
      contextWindow: context,
      maxOutputTokens: Math.min(context, CODEX_MAX_OUTPUT),
    });
  }

  const slugs = configuredModels ?? [...fromCache.keys()];
  return slugs.map((modelId) => {
    const caps = fromCache.get(modelId);
    return {
      upstreamId,
      modelId,
      capabilities: caps ?? {
        tools: true,
        modalities: ["text", "image"],
        contextWindow: 256_000,
        maxOutputTokens: CODEX_MAX_OUTPUT,
      },
      source: caps ? ("provider-native" as const) : ("default" as const),
    };
  });
}

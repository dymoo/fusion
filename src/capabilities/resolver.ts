import type { FusionConfig } from "../config/schema.js";
import type { Upstream } from "../upstreams/types.js";
import { logger } from "../util/logger.js";
import { intersectCapabilities } from "./intersect.js";
import { lookupModelsDev } from "./sources/models-dev.js";
import {
  applyOverride,
  type Capabilities,
  type CapabilityOverrides,
  CONSERVATIVE_DEFAULT,
  type ModelDescriptor,
} from "./types.js";

/**
 * Resolves and caches per-upstream capabilities from layered sources:
 * provider-native (from upstream.discover) > models.dev registry > config
 * override > conservative default. Refreshes on an interval and keeps the last
 * good result if a refresh fails.
 */
export class CapabilityResolver {
  private store = new Map<string, ModelDescriptor[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly upstreams: Map<string, Upstream>,
    private readonly config: FusionConfig,
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    const intervalMs = this.config.capabilities.refreshIntervalSec * 1000;
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    for (const upstream of this.upstreams.values()) {
      const override = this.overrideFor(upstream.id);
      try {
        const discovered = await upstream.discover();
        const enriched = discovered.map((d) => this.enrich(d, override));
        if (enriched.length > 0) this.store.set(upstream.id, enriched);
        else if (!this.store.has(upstream.id)) {
          this.store.set(upstream.id, [this.fallbackDescriptor(upstream.id, override)]);
        }
      } catch (err) {
        logger.warn("capability discovery failed", {
          upstream: upstream.id,
          error: (err as Error).message,
        });
        if (!this.store.has(upstream.id)) {
          this.store.set(upstream.id, [this.fallbackDescriptor(upstream.id, override)]);
        }
      }
    }
  }

  private overrideFor(upstreamId: string): CapabilityOverrides | undefined {
    return this.config.upstreams.find((u) => u.id === upstreamId)?.capabilityOverrides;
  }

  private enrich(d: ModelDescriptor, override: CapabilityOverrides | undefined): ModelDescriptor {
    let caps = d.capabilities;
    let source = d.source;
    if (d.source !== "provider-native") {
      const md = lookupModelsDev(d.modelId);
      if (md) {
        caps = md;
        source = "models-dev";
      }
    }
    if (override && Object.keys(override).length > 0) {
      caps = applyOverride(caps, override);
      source = "config-override";
    }
    return { ...d, capabilities: caps, source };
  }

  private fallbackDescriptor(
    upstreamId: string,
    override: CapabilityOverrides | undefined,
  ): ModelDescriptor {
    const wanted = this.config.upstreams.find((u) => u.id === upstreamId)?.models?.[0];
    return {
      upstreamId,
      modelId: wanted ?? upstreamId,
      capabilities: applyOverride(CONSERVATIVE_DEFAULT, override),
      source: override && Object.keys(override).length > 0 ? "config-override" : "default",
    };
  }

  descriptorsFor(upstreamId: string): ModelDescriptor[] {
    return this.store.get(upstreamId) ?? [];
  }

  /** Representative capabilities for the model this upstream will actually use. */
  representativeCaps(upstreamId: string): Capabilities {
    const list = this.descriptorsFor(upstreamId);
    const wanted = this.config.upstreams.find((u) => u.id === upstreamId)?.models?.[0];
    const chosen = wanted ? (list.find((d) => d.modelId === wanted) ?? list[0]) : list[0];
    if (chosen) return chosen.capabilities;
    return applyOverride(CONSERVATIVE_DEFAULT, this.overrideFor(upstreamId));
  }

  /** Least-capable intersection across a set of upstreams. */
  floorFor(upstreamIds: string[]): Capabilities {
    return intersectCapabilities(upstreamIds.map((id) => this.representativeCaps(id)));
  }

  imageCapable(upstreamId: string): boolean {
    return this.representativeCaps(upstreamId).modalities.includes("image");
  }
}

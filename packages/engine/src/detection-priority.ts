import { type EngineConfig, normalizeCategory } from "./config.js";
import type { ProtectedValue } from "./plugins/types.js";

/**
 * Arbitrate one value claimed under two categories, using only explicit engine config:
 *   1. a destroy category beats a surrogate one (the irreversible disposition cannot leak a mapping);
 *   2. then the earlier category in `detection.entityPriority` wins.
 * Negative: `a` wins. Positive: `b` wins. Zero: config expresses no preference, so the caller keeps
 * its own tie-breaks. The result never depends on which detector ran or answered first.
 */
export function compareCategoryClaims(
  a: Pick<ProtectedValue, "name">,
  b: Pick<ProtectedValue, "name">,
  config: Pick<EngineConfig, "detection" | "dispositions">,
): number {
  const destroyed = config.dispositions.destroy.labels;
  const aDestroyed = Object.hasOwn(destroyed, normalizeCategory(a.name));
  const bDestroyed = Object.hasOwn(destroyed, normalizeCategory(b.name));
  if (aDestroyed !== bDestroyed) return aDestroyed ? -1 : 1;
  return priorityRank(a.name, config) - priorityRank(b.name, config);
}

function priorityRank(name: string, config: Pick<EngineConfig, "detection">): number {
  const { entityPriority } = config.detection;
  const index = entityPriority.indexOf(normalizeCategory(name));
  return index < 0 ? entityPriority.length : index;
}

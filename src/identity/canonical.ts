// Model identity (plan v1.3 §5.1, §5.2 match confidence).
import type { CatalogModel } from "../types.ts"

/** Normalize a provider-native model id into a canonical-looking id. */
export function normalizeModelId(modelID: string): string {
  let id = modelID.trim().toLowerCase()
  id = id.replace(/:free$/, "").replace(/-free$/, "")
  return id
}

/**
 * canonical id + confidence:
 *  - models.dev canonical_model_id         → 1.0
 *  - provider-native "org/model" id         → 0.8 (normalized)
 *  - bare id without org                    → 0.6 (normalized, prefixed with provider)
 */
export function canonicalOf(m: CatalogModel): { canonicalID: string; matchConf: number } {
  if (m.canonicalID) return { canonicalID: m.canonicalID.toLowerCase(), matchConf: 1.0 }
  const n = normalizeModelId(m.modelID)
  if (n.includes("/")) return { canonicalID: n, matchConf: 0.8 }
  return { canonicalID: `${m.providerID}:${n}`, matchConf: 0.6 }
}

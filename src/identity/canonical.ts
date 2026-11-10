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
  if (m.canonicalID) return { canonicalID: m.canonicalID.toLowerCase(), matchConf: m.canonicalConf ?? 1.0 }
  const n = normalizeModelId(m.modelID)
  if (n.includes("/")) return { canonicalID: n, matchConf: 0.8 }
  return { canonicalID: `${m.providerID}:${n}`, matchConf: 0.6 }
}

/**
 * Alias index from every provider in the models.dev cache: normalized "org/model" id → canonical_model_id.
 * Ids that map to more than one canonical id are dropped (ambiguous).
 */
export function buildAliasIndex(modelsDev: Record<string, { models?: Record<string, any> }> | undefined): Map<string, string> {
  const seen = new Map<string, Set<string>>()
  for (const prov of Object.values(modelsDev ?? {})) {
    for (const [id, e] of Object.entries(prov?.models ?? {})) {
      if (typeof e?.canonical_model_id !== "string") continue
      const k = normalizeModelId(id)
      if (!k.includes("/")) continue
      if (!seen.has(k)) seen.set(k, new Set())
      seen.get(k)!.add(e.canonical_model_id.toLowerCase())
    }
  }
  const out = new Map<string, string>()
  for (const [k, v] of seen) if (v.size === 1) out.set(k, [...v][0]!)
  return out
}

/** Fill canonicalID for models without their own models.dev entry (e.g. xkiro), at confidence 0.9. */
export function applyAliases(models: CatalogModel[], aliases: Map<string, string>): void {
  for (const m of models) {
    if (m.canonicalID) continue
    const a = aliases.get(normalizeModelId(m.modelID))
    if (a) {
      m.canonicalID = a
      m.canonicalConf = 0.9
    }
  }
}

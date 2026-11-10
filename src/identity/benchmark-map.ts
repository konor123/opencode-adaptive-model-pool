// Map benchmark subjects (OpenRouter permaslugs, AA slugs) to OAMP canonical ids. Plan v1.3 §5.1/§5.2.
import { normalizeModelId } from "./canonical.ts"

export interface SubjectMatch {
  canonicalID: string
  conf: number
}

/** "z-ai/glm-5.3-flash-20260826" → "z-ai/glm-5.3-flash" */
export const orBase = (permaslug: string) => permaslug.toLowerCase().replace(/-\d{8}$/, "")

/** canonical "zhipuai/glm-5.3-flash" → AA-style key "glm-5-3-flash" */
export const aaKeyOf = (canonicalID: string) =>
  canonicalID.toLowerCase().split(/[/:]/).pop()!.replace(/[._]/g, "-")

export interface MapperRoute {
  canonicalID: string
  providerID: string
  modelID: string
}

export class BenchmarkMapper {
  private orIndex = new Map<string, string>() // openrouter model id (no :free) → canonical
  private aaIndex = new Map<string, Set<string>>() // aa key → canonicals

  constructor(routes: MapperRoute[], modelsDevOpenrouter?: Record<string, any>) {
    for (const [id, e] of Object.entries(modelsDevOpenrouter ?? {})) {
      if (typeof e?.canonical_model_id === "string") this.orIndex.set(normalizeModelId(id), e.canonical_model_id.toLowerCase())
    }
    for (const r of routes) {
      if (r.providerID === "openrouter") this.orIndex.set(normalizeModelId(r.modelID), r.canonicalID)
      const k = aaKeyOf(r.canonicalID)
      if (!this.aaIndex.has(k)) this.aaIndex.set(k, new Set())
      this.aaIndex.get(k)!.add(r.canonicalID)
    }
  }

  mapOr(permaslug: string): SubjectMatch {
    const base = orBase(permaslug)
    const viaCatalog = this.orIndex.get(base)
    if (viaCatalog) return { canonicalID: viaCatalog, conf: 1.0 }
    return { canonicalID: base, conf: 0.8 }
  }

  /** AA slugs are matched only when exactly one known canonical id has the same key. */
  mapAa(slug: string): SubjectMatch | undefined {
    const c = this.aaIndex.get(slug.toLowerCase())
    if (!c || c.size !== 1) return undefined
    return { canonicalID: [...c][0]!, conf: 0.8 }
  }

  map(source: string, via: string, subject: string): SubjectMatch | undefined {
    if (via === "openrouter-api") return this.mapOr(subject)
    if (via === "aa-api") return this.mapAa(subject)
    return undefined
  }
}

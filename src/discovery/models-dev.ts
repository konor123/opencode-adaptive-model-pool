// Read OpenCode's models.dev cache and compute the effective catalog the way OpenCode 1.19.5 filters it:
// drop deprecated (and alpha unless experimental), apply provider whitelist/blacklist and per-model disabled.
import { existsSync, readFileSync } from "node:fs"
import type { CatalogModel, Cost } from "../types.ts"

export type ModelsDev = Record<string, { models?: Record<string, any> }>

export function loadModelsDev(path: string): ModelsDev | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

function costOf(c: any): Cost | undefined {
  if (!c || typeof c !== "object") return undefined
  const input = num(c.input)
  const output = num(c.output)
  return input === undefined || output === undefined ? undefined : { input, output }
}

/** Convert a models.dev entry or an OpenCode config model entry into a CatalogModel. */
export function toCatalogModel(providerID: string, modelID: string, e: any, source: CatalogModel["source"]): CatalogModel {
  return {
    providerID,
    modelID,
    name: typeof e?.name === "string" ? e.name : undefined,
    canonicalID: typeof e?.canonical_model_id === "string" ? e.canonical_model_id : undefined,
    family: typeof e?.family === "string" ? e.family : undefined,
    cost: costOf(e?.cost),
    toolCall: typeof e?.tool_call === "boolean" ? e.tool_call : undefined,
    reasoning: typeof e?.reasoning === "boolean" ? e.reasoning : undefined,
    contextLimit: num(e?.limit?.context),
    outputLimit: num(e?.limit?.output),
    inputModalities: Array.isArray(e?.modalities?.input) ? e.modalities.input : undefined,
    outputModalities: Array.isArray(e?.modalities?.output) ? e.modalities.output : undefined,
    status: typeof e?.status === "string" ? e.status : undefined,
    source,
  }
}

/**
 * Effective catalog for the given providers.
 * cfg = OpenCode config object (after OAMP injection), modelsDev = models.dev cache.
 */
/**
 * Whether this OpenCode instance can call a provider (review C03): a provider block with an api key / file / env
 * reference, a credential in OpenCode's auth store, one of the provider's env vars, or OpenCode's own provider
 * (which serves its free models with a public key). A models.dev entry alone is not enough.
 */
export function providerConnected(pid: string, cfg: any, modelsDev: ModelsDev | undefined, authKeys: Set<string>): boolean {
  if (pid === "opencode") return true
  if (cfg?.disabled_providers?.includes?.(pid)) return false
  if (Array.isArray(cfg?.enabled_providers) && !cfg.enabled_providers.includes(pid)) return false
  if (typeof cfg?.provider?.[pid]?.options?.apiKey === "string" && cfg.provider[pid].options.apiKey) return true
  if (authKeys.has(pid)) return true
  const env: unknown = (modelsDev?.[pid] as any)?.env
  return Array.isArray(env) && env.some((k) => typeof k === "string" && !!process.env[k])
}

export function effectiveCatalog(
  cfg: any,
  modelsDev: ModelsDev | undefined,
  providers: string[],
  experimental = false,
  enrich: Record<string, CatalogModel[] | undefined> = {},
  authKeys?: Set<string>,
): {
  models: CatalogModel[]
  covered: string[]
} {
  const out: CatalogModel[] = []
  const covered: string[] = []
  for (const pid of providers) {
    const pcfg = cfg?.provider?.[pid]
    const dev = modelsDev?.[pid]?.models
    if (!pcfg && !dev) continue
    if (authKeys && !providerConnected(pid, cfg, modelsDev, authKeys)) continue
    covered.push(pid)
    const merged = new Map<string, { e: any; source: CatalogModel["source"] }>()
    for (const [mid, e] of Object.entries(dev ?? {})) merged.set(mid, { e, source: "models.dev" })
    for (const [mid, e] of Object.entries((pcfg?.models ?? {}) as Record<string, any>)) {
      const prev = merged.get(mid)
      merged.set(mid, prev ? { e: { ...prev.e, ...e }, source: prev.source } : { e, source: "config" })
    }
    const wl: string[] | undefined = Array.isArray(pcfg?.whitelist) ? pcfg.whitelist : undefined
    const bl: string[] | undefined = Array.isArray(pcfg?.blacklist) ? pcfg.blacklist : undefined
    for (const [mid, { e, source }] of merged) {
      if (e?.disabled === true) continue
      if (e?.status === "deprecated") continue
      if (e?.status === "alpha" && !experimental) continue
      if (bl?.includes(mid)) continue
      if (wl && !wl.includes(mid)) continue
      const m = toCatalogModel(pid, mid, e, source)
      const api = enrich[pid]?.find((x) => x.modelID === mid)
      // provider-api metadata (access tier, pricing) fills what the config entry does not say
      out.push(api ? { ...api, ...definedOnly(m), cost: m.cost ?? api.cost, source: "provider-api" } : m)
    }
  }
  return { models: out, covered }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

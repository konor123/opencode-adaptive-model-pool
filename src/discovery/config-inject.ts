// V1 `config` hook injection (plan v1.3 §4.1 A): put cached provider models into the in-memory OpenCode config.
// The config file on disk is never written.
import type { CatalogModel } from "../types.ts"

export interface InjectReport {
  provider: string
  models: number
  whitelistDropped: boolean
}

function toConfigModel(m: CatalogModel): Record<string, unknown> {
  const e: Record<string, unknown> = { name: m.name ?? m.modelID }
  if (m.toolCall !== undefined) e.tool_call = m.toolCall
  if (m.reasoning !== undefined) e.reasoning = m.reasoning
  if (m.contextLimit !== undefined && m.outputLimit !== undefined) e.limit = { context: m.contextLimit, output: m.outputLimit }
  if (m.cost) e.cost = { input: m.cost.input, output: m.cost.output }
  return e
}

/**
 * For each provider with a non-empty cache and an existing provider block in cfg:
 *  - models := cached API list; fields the user set on a model in config take precedence
 *  - whitelist: kept if it intersects the new list, otherwise dropped (in memory) so the provider is not emptied
 */
export function injectProviderModels(cfg: any, caches: Record<string, CatalogModel[] | undefined>): InjectReport[] {
  const reports: InjectReport[] = []
  for (const [pid, list] of Object.entries(caches)) {
    const pcfg = cfg?.provider?.[pid]
    if (!pcfg || !list?.length) continue
    const prev: Record<string, any> = pcfg.models ?? {}
    const models: Record<string, any> = {}
    for (const m of list) models[m.modelID] = { ...toConfigModel(m), ...(prev[m.modelID] ?? {}) }
    pcfg.models = models
    let whitelistDropped = false
    if (Array.isArray(pcfg.whitelist) && !pcfg.whitelist.some((id: string) => id in models)) {
      delete pcfg.whitelist
      whitelistDropped = true
    }
    reports.push({ provider: pid, models: list.length, whitelistDropped })
  }
  return reports
}

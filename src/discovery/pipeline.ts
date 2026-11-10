// Discovery pipeline: provider /v1/models refresh (leased) + effective catalog → routes.
import { readFileSync } from "node:fs"
import { log } from "../log.ts"
import type { OampOptions } from "../options.ts"
import { applyAliases, buildAliasIndex } from "../identity/canonical.ts"
import { buildRoute } from "../policy/eligibility.ts"
import { acquireLease, type Db, kvSet, releaseLease } from "../storage/db.ts"
import type { CatalogModel } from "../types.ts"
import { getProviderCache, setProviderCache } from "./cache.ts"
import { injectProviderModels, type InjectReport } from "./config-inject.ts"
import { resolveProviderKey } from "./credentials.ts"
import { effectiveCatalog, type ModelsDev } from "./models-dev.ts"
import { fetchProviderModels } from "./provider-api.ts"
import { type SyncReport, syncRoutes } from "./sync.ts"

export type ProviderRefreshResult = Record<string, { ok: boolean; count?: number; error?: string; skipped?: string }>

export async function refreshProviderModels(
  db: Db,
  opts: OampOptions,
  cfg: any,
  o: { force?: boolean; only?: string[]; fetchImpl?: typeof fetch; timeoutMs?: number; holder?: string; now?: number } = {},
): Promise<ProviderRefreshResult> {
  const holder = o.holder ?? `pid:${process.pid}`
  const now = o.now ?? Date.now()
  const result: ProviderRefreshResult = {}
  if (!acquireLease(db, "provider-sync", holder, 60_000, now)) return { _lease: { ok: false, skipped: "held by another process" } }
  try {
    for (const [pid, spec] of Object.entries(opts.providerSync)) {
      if (o.only && !o.only.includes(pid)) continue
      if (!cfg?.provider?.[pid]) { result[pid] = { ok: false, skipped: "provider not configured" }; continue }
      const cached = getProviderCache(db, pid)
      if (!o.force && cached && now - cached.fetchedAt < opts.refresh.providerModelsHours * 3_600_000) {
        result[pid] = { ok: true, count: cached.models.length, skipped: "fresh" }
        continue
      }
      const key = resolveProviderKey(pid, cfg.provider[pid], opts.paths.opencodeAuth)
      try {
        const models = await fetchProviderModels(pid, key, spec, { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs })
        setProviderCache(db, pid, models, now)
        result[pid] = { ok: true, count: models.length }
      } catch (e: any) {
        result[pid] = { ok: false, error: String(e?.message ?? e) }
        log("warn", "provider refresh failed", { provider: pid, error: result[pid].error })
      }
      kvSet(db, `provider-sync:${pid}`, JSON.stringify({ ...result[pid], at: now }), now)
    }
  } finally {
    releaseLease(db, "provider-sync", holder)
  }
  return result
}

/** Provider ids that have a credential in OpenCode's auth store (values are never read into memory beyond this check). */
export function authProviders(authPath: string): Set<string> {
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"))
    return new Set(Object.entries(auth ?? {}).filter(([, v]: [string, any]) => v && (v.key || v.access || v.refresh)).map(([k]) => k))
  } catch {
    return new Set()
  }
}

export function loadCaches(db: Db, opts: OampOptions): Record<string, CatalogModel[] | undefined> {
  const out: Record<string, CatalogModel[] | undefined> = {}
  for (const pid of Object.keys(opts.providerSync)) out[pid] = getProviderCache(db, pid)?.models
  return out
}

export function applyAndSync(db: Db, opts: OampOptions, cfg: any, modelsDev: ModelsDev | undefined, now = Date.now()): {
  inject: InjectReport[]
  sync: SyncReport
  routes: number
  eligible: number
} {
  const caches = loadCaches(db, opts)
  const inject = injectProviderModels(cfg, caches)
  const { models, covered } = effectiveCatalog(cfg, modelsDev, opts.providers, cfg?.experimental?.enableExperimentalModels === true, caches, authProviders(opts.paths.opencodeAuth))
  applyAliases(models, buildAliasIndex(modelsDev))
  const routes = models.map((m) => buildRoute(m, opts))
  const sync = syncRoutes(db, routes, covered, now)
  kvSet(db, "catalog:last-sync", JSON.stringify({ at: now, routes: routes.length, ...sync }), now)
  return { inject, sync, routes: routes.length, eligible: routes.filter((r) => r.eligible).length }
}

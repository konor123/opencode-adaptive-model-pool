// OAMP OpenCode plugin entry (V1 hooks; external V2 plugins are not loadable in OpenCode 1.19.5, see docs/compatibility.md E1).
// Phases 1–2: provider model discovery (config hook injection), route registry, real-usage import, benchmarks and
// performance scores. No model selection yet (Phase 3).
import { applyAndSync, loadCaches, refreshProviderModels } from "./discovery/pipeline.ts"
import { loadModelsDev } from "./discovery/models-dev.ts"
import { initLog, log } from "./log.ts"
import { resolveOptions } from "./options.ts"
import { type Db, kvGet, kvSet, openDb } from "./storage/db.ts"
import { refreshBenchmarks } from "./benchmarks/refresh.ts"
import { computePerformanceScores } from "./scoring/compute.ts"
import { importUsage, OVERLAP_MS } from "./telemetry/usage-import.ts"

const FIRST_FETCH_TIMEOUT_MS = 5000

export const OampPlugin = async (_input: unknown, rawOptions?: unknown) => {
  const opts = resolveOptions(rawOptions)
  if (!opts.enabled) return {}
  initLog(opts.storage.path)
  let db: Db
  try {
    db = openDb(opts.storage.path)
  } catch (e: any) {
    log("error", "storage open failed; OAMP disabled for this process", { error: String(e?.message ?? e) })
    return {}
  }

  return {
    config: async (cfg: any) => {
      try {
        // First run for a provider (no cache yet): fetch synchronously with a short timeout so it appears now.
        const caches = loadCaches(db, opts)
        const missing = Object.keys(opts.providerSync).filter((p) => cfg?.provider?.[p] && !caches[p]?.length)
        if (missing.length) await refreshProviderModels(db, opts, cfg, { only: missing, timeoutMs: FIRST_FETCH_TIMEOUT_MS })

        const res = applyAndSync(db, opts, cfg, loadModelsDev(opts.paths.modelsDevCache))
        log("info", "catalog synced", { inject: res.inject, sync: res.sync, routes: res.routes, eligible: res.eligible })

        // Background work never blocks startup.
        let cfgSnapshot: any
        try {
          cfgSnapshot = { provider: JSON.parse(JSON.stringify(cfg?.provider ?? {})) }
        } catch {
          cfgSnapshot = { provider: {} }
        }
        setTimeout(async () => {
          await refreshProviderModels(db, opts, cfgSnapshot).catch((e) => log("warn", "background refresh failed", { error: String(e) }))
          let usageChanged = false
          try {
            const cursor = Number(kvGet(db, "usage:cursor") ?? 0)
            const u = importUsage(db, opts.paths.opencodeDb, { sinceMs: Math.max(0, cursor - OVERLAP_MS) })
            kvSet(db, "usage:cursor", String(u.cursor))
            kvSet(db, "usage:last", JSON.stringify({ at: Date.now(), ...u }))
            usageChanged = u.inserted > 0
          } catch (e: any) {
            log("warn", "usage import failed", { error: String(e?.message ?? e) })
          }
          try {
            const b = await refreshBenchmarks(db, opts, cfgSnapshot)
            const fetched = Object.values(b).some((x) => x.ok && x.count)
            if (fetched || usageChanged || !kvGet(db, "scores:last")) {
              const s = computePerformanceScores(db, opts, loadModelsDev(opts.paths.modelsDevCache)?.openrouter?.models)
              log("info", "performance scores", { benchmarks: b, routes: s.length, withEvidence: s.filter((x) => x.result.used.length).length })
            }
          } catch (e: any) {
            log("warn", "benchmark/scoring failed", { error: String(e?.message ?? e) })
          }
        }, 0)
      } catch (e: any) {
        log("error", "config hook failed; OpenCode config left as-is", { error: String(e?.message ?? e) })
      }
    },
  }
}

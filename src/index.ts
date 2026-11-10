// OAMP OpenCode plugin entry (V1 hooks; external V2 plugins are not loadable in OpenCode 1.19.5, see docs/compatibility.md E1).
// Phases 1–2: provider model discovery (config hook injection), route registry, real-usage import, benchmarks and
// performance scores; Phase 3: live telemetry, latency/availability scores and the oamp/* turn-level selector.
import { applyAndSync, loadCaches, refreshProviderModels } from "./discovery/pipeline.ts"
import { loadModelsDev } from "./discovery/models-dev.ts"
import { initLog, log } from "./log.ts"
import { resolveOptions } from "./options.ts"
import { type Db, kvGet, kvSet, openDb } from "./storage/db.ts"
import { refreshBenchmarks } from "./benchmarks/refresh.ts"
import { computePerformanceScores } from "./scoring/compute.ts"
import { recordOutcome } from "./scoring/health.ts"
import { InTurnFailover } from "./selector/failover.ts"
import { MARKER_PROVIDER, Selector } from "./selector/hook.ts"
import { LiveTelemetry } from "./telemetry/live.ts"
import { importUsage, OVERLAP_MS } from "./telemetry/usage-import.ts"

const FIRST_FETCH_TIMEOUT_MS = 5000

/** In-memory marker provider: `oamp/<pool>` models are selection markers, never called (baseURL is a discard port). */
export function injectMarkerProvider(cfg: any, pools: string[]) {
  cfg.provider ??= {}
  if (cfg.provider[MARKER_PROVIDER]) return
  cfg.provider[MARKER_PROVIDER] = {
    npm: "@ai-sdk/openai-compatible",
    name: "OAMP (adaptive)",
    options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "unused" },
    models: Object.fromEntries(pools.map((p) => [p, { name: `OAMP ${p}`, tool_call: true, cost: { input: 0, output: 0 } }])),
  }
}

export const OampPlugin = async (input: any, rawOptions?: unknown) => {
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

  const telemetry = new LiveTelemetry(db)
  const selector = new Selector({
    db,
    opts,
    parentOf: async (sessionID) => {
      const r = await input?.client?.session?.get?.({ path: { id: sessionID } })
      return r?.data?.parentID ?? undefined
    },
  })
  // `opencode run` exits as soon as its session is aborted, so an in-turn switch would end the run with no answer
  // (verified 2026-11-10). There, leave retries to OpenCode and switch on the next turn instead.
  const command = process.argv[2]
  const failover = new InTurnFailover({ db, opts, selector, client: command === "run" ? undefined : input?.client })
  log("info", "plugin init", { command: command ?? "tui", inTurnFailover: opts.selector.inTurnFailover && command !== "run" })
  telemetry.onFailure = (route, cls) => {
    recordOutcome(db, route, cls)
    selector.invalidate()
    log("warn", "route failure recorded", { route, errorClass: cls })
  }
  telemetry.onSuccess = (route) => {
    // only touch the health table when the route is not already plainly healthy
    const row = db.query("SELECT state, consecutive_fail FROM health_states WHERE route_id = ?").get(route) as { state: string; consecutive_fail: number } | null
    if (row && (row.state !== "healthy" || row.consecutive_fail > 0)) {
      recordOutcome(db, route, undefined)
      selector.invalidate()
    }
  }
  telemetry.isStaleRetry = (sessionID) => failover.isQuiet(sessionID)
  telemetry.onRetryEvent = (sessionID, route, cls, attempt) => {
    failover.onRetry(sessionID, route, cls, attempt).catch((e) => log("error", "failover failed", { error: String(e) }))
  }
  const safe = (name: string, f: () => unknown) => {
    try {
      const r = f()
      if (r instanceof Promise) return r.catch((e: any) => log("error", `${name} failed`, { error: String(e?.message ?? e) }))
    } catch (e: any) {
      log("error", `${name} failed`, { error: String(e?.message ?? e) })
    }
  }

  return {
    "chat.message": async (inp: any, out: any) =>
      safe("chat.message", async () => {
        failover.noteTurn(inp.sessionID, inp.agent, out?.parts)
        await selector.onChatMessage(inp, out)
      }),
    "chat.headers": async (inp: any) => safe("chat.headers", () => telemetry.onHeaders(inp.sessionID, inp.agent)),
    event: async ({ event }: any) =>
      safe("event", () => {
        telemetry.onEvent(event)
        if (event?.type === "session.created") selector.onSessionCreated(event.properties?.info?.id, event.properties?.info?.parentID)
      }),
    config: async (cfg: any) => {
      try {
        injectMarkerProvider(cfg, Object.keys(opts.pools))
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

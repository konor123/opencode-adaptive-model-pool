// Leased, rate-limit aware benchmark refresh (plan v1.3 §10 refresh.benchmarkHours, AA 100 req/24h).
import { existsSync, readFileSync } from "node:fs"
import { resolveProviderKey } from "../discovery/credentials.ts"
import { log } from "../log.ts"
import type { OampOptions } from "../options.ts"
import { acquireLease, type Db, kvGet, kvSet, releaseLease } from "../storage/db.ts"
import { AaFetchError, type AaModel, fetchAaModels } from "./artificial-analysis.ts"
import { fetchOrBenchmarks } from "./openrouter.ts"
import { loadSnapshots } from "./snapshots.ts"
import { storeObservations } from "./store.ts"
import type { BenchObservation } from "./types.ts"

export type BenchRefreshResult = Record<string, { ok: boolean; count?: number; error?: string; skipped?: string }>

export function aaObservations(models: AaModel[], indexVersion: number | undefined): BenchObservation[] {
  const version = indexVersion !== undefined ? `ii-v${indexVersion}` : "v2"
  const out: BenchObservation[] = []
  const cite = "Source: Artificial Analysis (artificialanalysis.ai)"
  for (const m of models) {
    const at = m.releaseDate && !Number.isNaN(Date.parse(m.releaseDate)) ? undefined : undefined
    const push = (benchmark: string, raw: number | undefined) =>
      raw !== undefined && out.push({ source: "aa", via: "aa-api", benchmark, version, subject: m.slug, raw, evaluatedAt: at, citation: cite })
    push("aa_intelligence", m.intelligenceIndex)
    push("aa_coding", m.codingIndex)
    push("aa_agentic", m.agenticIndex)
    // speed priors (model-level medians across providers); not part of P
    push("speed_tps", m.medianTps)
    push("speed_ttft_s", m.medianTtftS)
    push("speed_ttfa_s", m.medianTtfaS)
    push("speed_e2e_s", m.medianE2eS)
  }
  return out
}

const due = (db: Db, key: string, hours: number, now: number) => {
  const raw = kvGet(db, key)
  if (!raw) return true
  try {
    const s = JSON.parse(raw)
    if (typeof s.notBefore === "number" && now < s.notBefore) return false
    return !s.ok || now - s.at >= hours * 3_600_000
  } catch {
    return true
  }
}

export async function refreshBenchmarks(
  db: Db,
  opts: OampOptions,
  cfg: any,
  o: { force?: boolean; fetchImpl?: typeof fetch; now?: number; holder?: string } = {},
): Promise<BenchRefreshResult> {
  const now = o.now ?? Date.now()
  const holder = o.holder ?? `pid:${process.pid}`
  const res: BenchRefreshResult = {}
  if (!acquireLease(db, "benchmarks", holder, 180_000, now)) return { _lease: { ok: false, skipped: "held by another process" } }
  try {
    // OpenRouter (re-serves AA coding/agentic + own gpqa/tau-bench)
    if (!opts.benchmarks.openrouter.enabled) res.openrouter = { ok: false, skipped: "disabled" }
    else if (!o.force && !due(db, "bench-sync:openrouter", opts.refresh.benchmarkHours, now)) res.openrouter = { ok: true, skipped: "fresh" }
    else {
      const key = resolveProviderKey("openrouter", cfg?.provider?.openrouter, opts.paths.opencodeAuth)
      if (!key) res.openrouter = { ok: false, error: "no OpenRouter key" }
      else {
        try {
          const obs = await fetchOrBenchmarks(key, { fetchImpl: o.fetchImpl })
          res.openrouter = { ok: true, count: storeObservations(db, obs, now) }
        } catch (e: any) {
          res.openrouter = { ok: false, error: String(e?.message ?? e) }
        }
      }
      kvSet(db, "bench-sync:openrouter", JSON.stringify({ ...res.openrouter, at: now }), now)
    }

    // Artificial Analysis free API (intelligence index + speed priors)
    const aa = opts.benchmarks.artificialAnalysis
    if (!aa.enabled) res.aa = { ok: false, skipped: "disabled" }
    else if (!existsSync(aa.keyFile)) res.aa = { ok: false, skipped: "no key file" }
    else if (!o.force && !due(db, "bench-sync:aa", opts.refresh.benchmarkHours, now)) res.aa = { ok: true, skipped: "fresh" }
    else {
      const key = readFileSync(aa.keyFile, "utf8").trim()
      let notBefore: number | undefined
      let remaining: number | undefined
      try {
        const r = await fetchAaModels(key, { fetchImpl: o.fetchImpl })
        remaining = r.rateLimitRemaining
        res.aa = { ok: true, count: storeObservations(db, aaObservations(r.models, r.indexVersion), now) }
      } catch (e: any) {
        if (e instanceof AaFetchError && e.retryAfterS) notBefore = now + e.retryAfterS * 1000
        res.aa = { ok: false, error: String(e?.message ?? e) }
      }
      kvSet(db, "bench-sync:aa", JSON.stringify({ ...res.aa, at: now, notBefore, rateLimitRemaining: remaining }), now)
    }
  } finally {
    releaseLease(db, "benchmarks", holder)
  }
  // local versioned snapshots: cheap and idempotent, stored on every refresh
  try {
    const snaps = loadSnapshots()
    res.snapshots = { ok: true, count: storeObservations(db, snaps, now) }
  } catch (e: any) {
    res.snapshots = { ok: false, error: String(e?.message ?? e) }
  }
  for (const [k, v] of Object.entries(res)) if (!v.ok && v.error) log("warn", "benchmark refresh failed", { source: k, error: v.error })
  return res
}

// Per-pool route scores R = (w_p·P_eff + w_l·L) × H (plan v1.3 §5.4–5.5), persisted in `scores`.
import { globMatch, type OampOptions } from "../options.ts"
import { buildRoute } from "../policy/eligibility.ts"
import type { CatalogModel } from "../types.ts"
import { type Db, kvGet, kvSet } from "../storage/db.ts"
import { type HealthVerdict, loadHealth, verdict } from "./health.ts"
import { availability, AVAILABILITY_FAILURES, DEFAULT_LATENCY_REFS, latencyScore, type LatencyRefs, percentile } from "./latency.ts"

export interface RouteScore {
  routeID: string
  providerID: string
  modelID: string
  pool: string
  pEff: number
  l: number
  h: number
  r: number
  ctxLimit?: number
  samples: number
  health: HealthVerdict
  maxSessions?: number
}

const SAMPLE_LIMIT = 200
const OUTCOME_LIMIT = 50

/** Freeze latency reference ranges (p10/p90) from history the first time enough data exists. */
export function latencyRefs(db: Db): LatencyRefs {
  const stored = kvGet(db, "ref:latency")
  if (stored) return JSON.parse(stored)
  const rows = db
    .query(`SELECT e2e_ms, tps, ttfa_ms FROM request_metrics WHERE kind IN ('history','primary') AND outcome = 'ok'`)
    .all() as { e2e_ms: number | null; tps: number | null; ttfa_ms: number | null }[]
  const e2e = rows.map((r) => r.e2e_ms).filter((x): x is number => !!x && x > 0)
  const tps = rows.map((r) => r.tps).filter((x): x is number => !!x && x > 0)
  if (e2e.length < 200 || tps.length < 100) return DEFAULT_LATENCY_REFS
  const refs: LatencyRefs = {
    e2e: { min: percentile(e2e, 0.1)!, max: percentile(e2e, 0.9)! },
    tps: { min: percentile(tps, 0.1)!, max: percentile(tps, 0.9)! },
    ttfa: DEFAULT_LATENCY_REFS.ttfa, // no TTFA in history; frozen default until live data exists
  }
  kvSet(db, "ref:latency", JSON.stringify({ ...refs, frozenAt: Date.now(), n: e2e.length }))
  return refs
}

export function computeRouteScores(db: Db, opts: OampOptions, now = Date.now()): RouteScore[] {
  const routes = db
    .query(`SELECT r.*, s.p_eff FROM routes r
            LEFT JOIN scores s ON s.route_id = r.route_id AND s.pool = 'auto'
            WHERE r.status = 'active'`)
    .all()
    // the shared `eligible` column reflects whichever process synced last; re-evaluate with this process's policy (review C01)
    .filter((row: any) => opts.providers.includes(row.provider_id) && eligibleForPolicy(row, opts)) as {
      route_id: string; provider_id: string; model_id: string; ctx_limit: number | null; p_eff: number | null }[]
  const refs = latencyRefs(db)
  const samplesQ = db.query(`SELECT ts, ttfa_ms, e2e_ms, tps FROM request_metrics
    WHERE route_id = ? AND kind IN ('history','primary') AND outcome = 'ok' ORDER BY ts DESC LIMIT ${SAMPLE_LIMIT}`)
  const outcomesQ = db.query(`SELECT ts, outcome, error_class FROM request_metrics
    WHERE route_id = ? AND kind IN ('history','primary','aux') ORDER BY ts DESC LIMIT ${OUTCOME_LIMIT}`)
  // dynamic concurrency (plan §7.3): >20% rate limits over the last 10 min (≥5 requests) → at most one auto session
  const recent429 = db.query(`SELECT count(*) n, sum(error_class = 'rate_limit') rl FROM request_metrics
    WHERE route_id = ? AND kind IN ('primary','aux') AND ts >= ?`)
  const health = loadHealth(db)

  const base = routes.map((r) => {
    const samples = (samplesQ.all(r.route_id) as any[]).reverse().map((s) => ({ ts: s.ts, ttfaMs: s.ttfa_ms, e2eMs: s.e2e_ms, tps: s.tps }))
    const lat = latencyScore(samples, refs, opts.latency)
    const recent = outcomesQ.all(r.route_id) as { ts: number; outcome: string; error_class: string | null }[]
    const counted = recent.filter((o) => o.outcome === "ok" || (o.outcome === "error" && AVAILABILITY_FAILURES.has(o.error_class ?? "other")))
    const av = opts.weights.availabilityPenalty ? availability(counted.reverse().map((o) => ({ ok: o.outcome === "ok" }))) : { h: 1 }
    const limit = Object.entries(opts.routeLimits).find(([g]) => globMatch(g, r.route_id))?.[1]
    const rl = recent429.get(r.route_id, now - 10 * 60_000) as { n: number; rl: number | null }
    const throttled = rl.n >= 5 && (rl.rl ?? 0) / rl.n > 0.2
    const maxSessions = throttled ? Math.min(limit?.maxSessions ?? 1, 1) : limit?.maxSessions
    return { r, lat, h: av.h, health: verdict(health.get(r.route_id), now), maxSessions }
  })

  const out: RouteScore[] = []
  const upsert = db.query(`INSERT INTO scores (route_id, pool, p, p_eff, c, l, h, r, computed_at, detail_json)
    VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(route_id, pool) DO UPDATE SET p_eff = CASE WHEN scores.pool = 'auto' THEN scores.p_eff ELSE excluded.p_eff END, l = excluded.l, h = excluded.h, r = excluded.r, computed_at = excluded.computed_at,
      detail_json = CASE WHEN scores.pool = 'auto' THEN json_set(COALESCE(scores.detail_json, '{}'), '$.latency', json(?)) ELSE excluded.detail_json END`)
  db.transaction(() => {
    for (const [pool, cfg] of Object.entries(opts.pools)) {
      const wp = cfg.weights?.performance ?? opts.weights.performance
      const wl = cfg.weights?.latency ?? opts.weights.latency
      for (const b of base) {
        const pEff = b.r.p_eff ?? 50
        const r = (wp * pEff + wl * b.lat.l) * b.h
        const latJson = JSON.stringify(b.lat)
        upsert.run(b.r.route_id, pool, pEff, b.lat.l, b.h, r, now, JSON.stringify({ latency: b.lat }), latJson)
        out.push({ routeID: b.r.route_id, providerID: b.r.provider_id, modelID: b.r.model_id, pool, pEff, l: b.lat.l, h: b.h, r,
          ctxLimit: b.r.ctx_limit ?? undefined, samples: b.lat.n, health: b.health, maxSessions: b.maxSessions })
      }
    }
  })()
  kvSet(db, "route-scores:last", JSON.stringify({ at: now, routes: base.length }), now)
  return out
}

/** Rebuild the catalog facts stored with a route and apply the current policy to them. */
export function eligibleForPolicy(row: any, opts: OampOptions): boolean {
  let meta: any = {}
  try {
    meta = JSON.parse(row.meta_json ?? "{}")
  } catch {}
  const m: CatalogModel = {
    providerID: row.provider_id, modelID: row.model_id, name: meta.name, cost: meta.cost, accessTier: meta.accessTier, status: meta.status,
    toolCall: row.tools === null || row.tools === undefined ? undefined : !!row.tools, reasoning: row.reasoning === null ? undefined : !!row.reasoning,
    contextLimit: row.ctx_limit ?? undefined, outputLimit: row.out_limit ?? undefined, inputModalities: meta.in, outputModalities: meta.outMod,
    source: row.source,
  }
  return buildRoute(m, opts).eligible
}

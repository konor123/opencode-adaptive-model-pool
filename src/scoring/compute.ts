// Compute and persist performance scores for every active route (pool "auto").
import { loadObservations, type StoredObservation } from "../benchmarks/store.ts"
import { BenchmarkMapper } from "../identity/benchmark-map.ts"
import type { OampOptions } from "../options.ts"
import { type Db, kvGet, kvSet } from "../storage/db.ts"
import { type Indicator, median, normalize, performance, type PerformanceResult, referenceRange } from "./performance.ts"

const refKey = (o: StoredObservation) => `ref:${o.source}:${o.via}:${o.benchmark}:${o.version}`

/** Freeze p5/p95 reference ranges per (source, via, benchmark, version) the first time a population is seen. */
export function ensureReferenceRanges(db: Db, obs: StoredObservation[]): Map<string, { min: number; max: number }> {
  const groups = new Map<string, number[]>()
  for (const o of obs) {
    if (!groups.has(refKey(o))) groups.set(refKey(o), [])
    groups.get(refKey(o))!.push(o.raw)
  }
  const out = new Map<string, { min: number; max: number }>()
  for (const [k, values] of groups) {
    const stored = kvGet(db, k)
    if (stored) {
      out.set(k, JSON.parse(stored))
      continue
    }
    const r = referenceRange(values)
    if (r) {
      kvSet(db, k, JSON.stringify({ ...r, n: values.length, frozenAt: Date.now() }))
      out.set(k, r)
    }
  }
  return out
}

export interface ScoredRoute {
  routeID: string
  canonicalID: string
  result: PerformanceResult
}

export function computePerformanceScores(db: Db, opts: OampOptions, modelsDevOpenrouter: Record<string, any> | undefined, now = Date.now()): ScoredRoute[] {
  const routes = db
    .query("SELECT route_id, provider_id, model_id, canonical_id, eligible FROM routes WHERE status IN ('active','stale')")
    .all() as { route_id: string; provider_id: string; model_id: string; canonical_id: string; eligible: number }[]
  const mapper = new BenchmarkMapper(
    routes.map((r) => ({ canonicalID: r.canonical_id, providerID: r.provider_id, modelID: r.model_id })),
    modelsDevOpenrouter,
  )
  const obs = loadObservations(db).filter((o) => !o.benchmark.startsWith("speed_"))
  const refs = ensureReferenceRanges(db, obs) // snapshot populations (incl. unmapped rows) shape their own ranges

  // canonical → indicator → best observation
  type Cand = { ind: Indicator; viaRank: number }
  const byCanon = new Map<string, Map<string, Cand>>()
  for (const o of obs) {
    const m = mapper.map(o.source, o.via, o.subject)
    const ref = refs.get(refKey(o))
    if (!m || !ref) continue
    const ind: Indicator = { value: normalize(o.raw, ref), matchConf: m.conf, at: o.evaluatedAt ?? o.collectedAt, origin: o.source }
    const viaRank = o.via === "openrouter-api" ? 0 : 1 // same AA measurement: prefer the OpenRouter copy, use only one
    if (!byCanon.has(m.canonicalID)) byCanon.set(m.canonicalID, new Map())
    const slot = byCanon.get(m.canonicalID)!
    const prev = slot.get(o.benchmark)
    const better = !prev || viaRank < prev.viaRank || (viaRank === prev.viaRank && (ind.at > prev.ind.at || (ind.at === prev.ind.at && ind.matchConf > prev.ind.matchConf)))
    if (better) slot.set(o.benchmark, { ind, viaRank })
  }

  const weights = { coding: opts.weights.coding, agentic: opts.weights.agentic, reasoning: opts.weights.reasoning }
  const upsert = db.query(`INSERT INTO scores (route_id, pool, p, p_eff, c, l, h, r, computed_at, detail_json)
    VALUES (?, 'auto', ?, ?, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(route_id, pool) DO UPDATE SET p = excluded.p, p_eff = excluded.p_eff, c = excluded.c, computed_at = excluded.computed_at, detail_json = excluded.detail_json`)
  // real-usage indicators (plan §5.1, replaces self-evaluation per 2026-11-10 decision)
  for (const [canon, inds] of usageIndicators(db, now)) {
    if (!byCanon.has(canon)) byCanon.set(canon, new Map())
    for (const [k, ind] of Object.entries(inds)) byCanon.get(canon)!.set(k, { ind, viaRank: 0 })
  }
  const indicatorsOf = (canon: string) => {
    const indicators: Record<string, Indicator> = {}
    for (const [k, v] of byCanon.get(canon) ?? []) indicators[k] = v.ind
    return indicators
  }
  // prior: median raw P of eligible routes that have evidence (pool-relative), or a fixed number
  let prior = 50
  if (opts.scoring.prior === "pool-median") {
    const ps = routes.filter((r) => r.eligible && byCanon.has(r.canonical_id)).map((r) => performance(indicatorsOf(r.canonical_id), now, weights).p)
    prior = median(ps) ?? 50
  } else if (typeof opts.scoring.prior === "number") prior = opts.scoring.prior
  const out: ScoredRoute[] = []
  db.transaction(() => {
    for (const r of routes) {
      const indicators = indicatorsOf(r.canonical_id)
      const res = performance(indicators, now, weights, prior)
      upsert.run(r.route_id, res.p, res.pEff, res.c, now, JSON.stringify({ ...res, indicators }))
      out.push({ routeID: r.route_id, canonicalID: r.canonical_id, result: res })
    }
  })()
  kvSet(db, "scores:last", JSON.stringify({ at: now, routes: out.length, withEvidence: out.filter((x) => x.result.used.length).length, prior }), now)
  return out
}

/** Fixed reference ranges for usage rates (percent). Hypotheses from the 2026-11-10 history; revisit with more data. */
export const USAGE_REFS = { usage_tools: { min: 90, max: 100 }, usage_edit: { min: 70, max: 100 } }
export const USAGE_MIN_SAMPLES = { usage_tools: 30, usage_edit: 20 }
export const USAGE_WINDOW_DAYS = 30

/** Aggregate real-usage tool signals per canonical model over the window. */
export function usageIndicators(db: Db, now = Date.now()): Map<string, Record<string, Indicator>> {
  const rows = db
    .query(
      `SELECT r.canonical_id AS canon, sum(m.tool_calls) AS calls, sum(m.tool_schema_err) AS schema,
              sum(m.edit_calls) AS edits, sum(m.edit_fail) AS edit_fail, max(m.ts) AS last
       FROM request_metrics m JOIN routes r ON r.route_id = m.route_id
       WHERE m.kind IN ('history','primary') AND m.ts >= ? AND m.tool_calls IS NOT NULL
       GROUP BY r.canonical_id`,
    )
    .all(now - USAGE_WINDOW_DAYS * 86_400_000) as { canon: string; calls: number; schema: number; edits: number; edit_fail: number; last: number }[]
  const out = new Map<string, Record<string, Indicator>>()
  for (const r of rows) {
    const inds: Record<string, Indicator> = {}
    if (r.calls >= USAGE_MIN_SAMPLES.usage_tools)
      inds.usage_tools = { value: normalize(100 * (1 - r.schema / r.calls), USAGE_REFS.usage_tools), matchConf: 1, at: r.last, origin: "usage" }
    if (r.edits >= USAGE_MIN_SAMPLES.usage_edit)
      inds.usage_edit = { value: normalize(100 * (1 - r.edit_fail / r.edits), USAGE_REFS.usage_edit), matchConf: 1, at: r.last, origin: "usage" }
    if (Object.keys(inds).length) out.set(r.canon, inds)
  }
  return out
}

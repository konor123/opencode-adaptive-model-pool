// Latency score L (plan v1.3 §5.3) and availability multiplier H (§5.5). Pure functions.

export interface LatencySample {
  ts: number
  ttfaMs?: number | null
  e2eMs?: number | null
  tps?: number | null
}

export interface LatencyRefs {
  ttfa: { min: number; max: number } // ms
  e2e: { min: number; max: number } // ms
  tps: { min: number; max: number } // tokens/s
}

/** Defaults used until a reference range has been frozen from real data. */
export const DEFAULT_LATENCY_REFS: LatencyRefs = {
  ttfa: { min: 500, max: 30_000 },
  e2e: { min: 1_500, max: 60_000 },
  tps: { min: 10, max: 200 },
}

const clamp100 = (x: number) => Math.min(100, Math.max(0, x))

/** Log-scale: lower latency → higher score. */
export function scoreLowerBetter(x: number, ref: { min: number; max: number }): number {
  if (!(x > 0) || !(ref.max > ref.min) || ref.min <= 0) return 50
  return clamp100((100 * (Math.log(ref.max) - Math.log(x))) / (Math.log(ref.max) - Math.log(ref.min)))
}

/** Log-scale: higher throughput → higher score. */
export function scoreHigherBetter(x: number, ref: { min: number; max: number }): number {
  if (!(x > 0) || !(ref.max > ref.min) || ref.min <= 0) return 50
  return clamp100((100 * (Math.log(x) - Math.log(ref.min))) / (Math.log(ref.max) - Math.log(ref.min)))
}

export function ewma(values: number[], alpha: number): number | undefined {
  let e: number | undefined
  for (const v of values) e = e === undefined ? v : alpha * v + (1 - alpha) * e
  return e
}

export function percentile(values: number[], p: number): number | undefined {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return undefined
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]
}

export interface LatencyResult {
  l: number
  lObs?: number
  n: number
  ewma: { ttfaMs?: number; e2eMs?: number; tps?: number }
  p50E2eMs?: number
  p95E2eMs?: number
}

/**
 * samples must be chronological. L_obs = weighted mean of the available sub-scores (weights renormalized);
 * L = (n·L_obs + n0·prior) / (n + n0)  (shrinkage toward the prior for routes with few samples).
 */
export function latencyScore(
  samples: LatencySample[],
  refs: LatencyRefs,
  w: { ttfa: number; e2e: number; tps: number; ewmaAlpha: number; priorWeight: number },
  prior = 50,
): LatencyResult {
  const pick = (f: (s: LatencySample) => number | null | undefined) => samples.map(f).filter((x): x is number => typeof x === "number" && x > 0)
  const ttfa = pick((s) => s.ttfaMs)
  const e2e = pick((s) => s.e2eMs)
  const tps = pick((s) => s.tps)
  const e = { ttfaMs: ewma(ttfa, w.ewmaAlpha), e2eMs: ewma(e2e, w.ewmaAlpha), tps: ewma(tps, w.ewmaAlpha) }
  let sw = 0
  let sv = 0
  if (e.ttfaMs !== undefined) { sw += w.ttfa; sv += w.ttfa * scoreLowerBetter(e.ttfaMs, refs.ttfa) }
  if (e.e2eMs !== undefined) { sw += w.e2e; sv += w.e2e * scoreLowerBetter(e.e2eMs, refs.e2e) }
  if (e.tps !== undefined) { sw += w.tps; sv += w.tps * scoreHigherBetter(e.tps, refs.tps) }
  const n = Math.max(ttfa.length, e2e.length)
  const lObs = sw > 0 ? sv / sw : undefined
  const l = lObs === undefined ? prior : (n * lObs + w.priorWeight * prior) / (n + w.priorWeight)
  return { l, lObs, n, ewma: e, p50E2eMs: percentile(e2e, 0.5), p95E2eMs: percentile(e2e, 0.95) }
}

/** Availability classes count against H; model/request-shaped errors (context overflow) and user aborts do not. */
export const AVAILABILITY_FAILURES = new Set(["rate_limit", "server", "timeout", "auth", "forbidden", "not_found", "bad_request", "other"])

/**
 * H = clamp(success_ewma, 0.5, 1)^2 over the last outcomes (chronological), aborts excluded.
 * With fewer than 5 outcomes the EWMA is blended with `prior`.
 */
export function availability(outcomes: { ok: boolean }[], prior = 0.9, alpha = 0.1): { h: number; success: number; n: number } {
  const xs = outcomes.map((o) => (o.ok ? 1 : 0))
  const n = xs.length
  let s = ewma(xs, alpha) ?? prior
  if (n < 5) s = (n * s + (5 - n) * prior) / 5
  const c = Math.min(1, Math.max(0.5, s))
  return { h: c * c, success: s, n }
}

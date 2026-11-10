// Performance score P, confidence c and P_eff (plan v1.3 §5.1–5.2). Pure functions; no I/O.

export type Category = "C" | "A" | "I"

/** indicator → [category, weight inside the category]. Unknown indicators are ignored. */
export const INDICATORS: Record<string, [Category, number]> = {
  aa_coding: ["C", 0.4],
  selfeval_coding: ["C", 0.25],
  swe_bench_pro: ["C", 0.15],
  usage_success: ["C", 0.2],
  aa_agentic: ["A", 0.35],
  tau_bench_airline: ["A", 0.25],
  selfeval_tools: ["A", 0.25],
  terminal_bench: ["A", 0.15],
  aa_intelligence: ["I", 0.6],
  gpqa_diamond: ["I", 0.25],
  livebench: ["I", 0.15],
}

export interface Weights {
  coding: number
  agentic: number
  reasoning: number
}
export const DEFAULT_WEIGHTS: Weights = { coding: 0.55, agentic: 0.3, reasoning: 0.15 }

export interface Indicator {
  /** 0..100, already normalized */
  value: number
  /** identity match confidence of the underlying subject */
  matchConf: number
  /** epoch ms of evaluation (or collection) */
  at: number
  /** independent origin: aa | openrouter | selfeval | snapshot | usage */
  origin: string
}

export interface PerformanceResult {
  p: number
  pEff: number
  c: number
  /** value assumed where evidence is missing (P_eff shrinks toward it) */
  prior: number
  categories: Record<Category, { score: number; coverage: number; proxy?: boolean }>
  coverage: number
  match: number
  recency: number
  independence: number
  used: string[]
}

const HALF_LIFE_DAYS = 180
const PROXY_FACTOR = 0.3
const NEUTRAL = 50

export function performance(indicators: Record<string, Indicator>, now: number, w: Weights = DEFAULT_WEIGHTS, prior = NEUTRAL): PerformanceResult {
  const top: Record<Category, number> = { C: w.coding, A: w.agentic, I: w.reasoning }
  const cats = {} as PerformanceResult["categories"]
  const used: string[] = []
  for (const cat of ["C", "A", "I"] as Category[]) {
    let sw = 0
    let sv = 0
    for (const [name, ind] of Object.entries(indicators)) {
      const spec = INDICATORS[name]
      if (!spec || spec[0] !== cat) continue
      sw += spec[1]
      sv += spec[1] * clamp(ind.value)
      used.push(name)
    }
    cats[cat] = sw > 0 ? { score: sv / sw, coverage: sw } : { score: prior, coverage: 0 }
  }
  // I → C proxy when coding evidence is entirely missing (hypothesis, plan §5.1)
  if (cats.C.coverage === 0 && cats.I.coverage > 0) cats.C = { score: cats.I.score, coverage: cats.I.coverage * PROXY_FACTOR, proxy: true }

  const p = top.C * cats.C.score + top.A * cats.A.score + top.I * cats.I.score
  const coverage = top.C * cats.C.coverage + top.A * cats.A.coverage + top.I * cats.I.coverage

  let wsum = 0
  let msum = 0
  let tsum = 0
  for (const name of used) {
    const ind = indicators[name]!
    const iw = INDICATORS[name]![1] * top[INDICATORS[name]![0]]
    wsum += iw
    msum += iw * ind.matchConf
    tsum += iw * ind.at
  }
  const match = wsum > 0 ? msum / wsum : 0
  const ageDays = wsum > 0 ? Math.max(0, (now - tsum / wsum) / 86_400_000) : 0
  const recency = wsum > 0 ? Math.pow(0.5, ageDays / HALF_LIFE_DAYS) : 0
  const origins = new Set(used.map((n) => indicators[n]!.origin))
  const independence = origins.size === 0 ? 0 : origins.size === 1 ? 0.7 : 1.0
  const c = clamp01(coverage * match * recency * independence)
  return { p, pEff: c * p + (1 - c) * prior, c, prior, categories: cats, coverage, match, recency, independence, used: [...new Set(used)] }
}

/** Fixed reference range normalization (plan §5.1): 0..100, higher is better. */
export function normalize(raw: number, ref: { min: number; max: number }): number {
  if (!(ref.max > ref.min)) return NEUTRAL
  return clamp(((raw - ref.min) / (ref.max - ref.min)) * 100)
}

/** p5/p95 of a population, used once to freeze a reference range. */
export function referenceRange(values: number[]): { min: number; max: number } | undefined {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (v.length < 5) return undefined
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!
  return { min: q(0.05), max: q(0.95) }
}

const clamp = (x: number) => Math.min(100, Math.max(0, x))
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export function median(values: number[]): number | undefined {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return undefined
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2
}

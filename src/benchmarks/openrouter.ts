// OpenRouter Benchmarks API (GET /api/v1/benchmarks). Verified 2026-11-10: AA rows carry coding/agentic indices.
import type { BenchObservation } from "./types.ts"

export const OR_BENCH_URL = "https://openrouter.ai/api/v1/benchmarks"

export class OrBenchError extends Error {}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const time = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined)

/** "(Max, Default Fallback)" / "(Xhigh)" → effort hint; undefined when absent. */
export function effortFromDisplayName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined
  const m = name.match(/\(([^)]*)\)\s*$/)
  if (!m) return undefined
  const first = m[1]!.split(",")[0]!.trim().toLowerCase()
  return /^(x?high|max|medium|low|minimal|none|non-reasoning|reasoning)$/.test(first) ? first : undefined
}

export function parseOrBenchmarks(body: any): BenchObservation[] {
  const rows: any[] = Array.isArray(body?.data) ? body.data : []
  const version = typeof body?.meta?.version === "string" ? body.meta.version : "v1"
  const asOf = time(body?.meta?.as_of)
  const citation = typeof body?.meta?.citation === "string" ? body.meta.citation : undefined
  const out: BenchObservation[] = []
  for (const r of rows) {
    const subject = r?.model_permaslug
    if (typeof subject !== "string" || !subject) continue
    if (r.source === "artificial-analysis") {
      const effort = effortFromDisplayName(r.display_name)
      for (const [field, bench] of [["intelligence_index", "aa_intelligence"], ["coding_index", "aa_coding"], ["agentic_index", "aa_agentic"]] as const) {
        const v = num(r[field])
        if (v !== undefined)
          out.push({ source: "aa", via: "openrouter-api", benchmark: bench, version, subject, effort, raw: v, evaluatedAt: asOf,
            citation: citation ?? "Source: Artificial Analysis (artificialanalysis.ai) via OpenRouter (openrouter.ai/rankings)" })
      }
    } else if (r.source === "openrouter") {
      const bench = r.benchmark_type === "gpqa_diamond" ? "gpqa_diamond" : r.benchmark_type === "tau_bench_verified_airline" ? "tau_bench_airline" : undefined
      const acc = num(r.accuracy)
      if (!bench || acc === undefined) continue
      out.push({ source: "openrouter", via: "openrouter-api", benchmark: bench, version, subject, raw: acc * 100,
        evaluatedAt: time(r.last_run_timestamp) ?? asOf, citation: citation ?? "Source: OpenRouter (openrouter.ai)" })
    }
  }
  return out
}

export async function fetchOrBenchmarks(apiKey: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<BenchObservation[]> {
  const f = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await f(OR_BENCH_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "oamp/0.1" },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
    })
  } catch (e: any) {
    throw new OrBenchError(`openrouter benchmarks fetch failed: ${e?.name ?? "Error"}`)
  }
  if (res.status >= 300 && res.status < 400) throw new OrBenchError(`openrouter benchmarks: redirect refused (HTTP ${res.status})`)
  if (!res.ok) throw new OrBenchError(`openrouter benchmarks: HTTP ${res.status}`)
  try {
    return parseOrBenchmarks(await res.json())
  } catch {
    throw new OrBenchError("openrouter benchmarks: invalid JSON")
  }
}

// Normalized benchmark observation (one number for one subject from one source).
export type BenchSource = "aa" | "openrouter" | "snapshot"

export interface BenchObservation {
  /** independent origin of the measurement. AA data re-served by OpenRouter is still "aa". */
  source: BenchSource
  /** where we fetched it from (for provenance), e.g. "openrouter-api", "aa-api" */
  via: string
  benchmark: string // e.g. aa_intelligence, aa_coding, aa_agentic, gpqa_diamond, tau_bench_airline
  version: string
  /** source-native model identifier (OR permaslug, AA slug) */
  subject: string
  effort?: string
  /** raw value on the source's scale (higher is better) */
  raw: number
  evaluatedAt?: number
  citation?: string
}

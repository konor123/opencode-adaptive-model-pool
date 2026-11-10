import { expect, test } from "bun:test"
import { BenchmarkMapper, aaKeyOf, orBase } from "../src/identity/benchmark-map.ts"
import { effortFromDisplayName, parseOrBenchmarks } from "../src/benchmarks/openrouter.ts"
import { normalize, performance, referenceRange } from "../src/scoring/performance.ts"

const NOW = Date.parse("2026-11-10T00:00:00Z")
const ind = (value: number, origin = "aa", matchConf = 1, at = NOW) => ({ value, origin, matchConf, at })

test("no evidence → neutral 50 with zero confidence", () => {
  const r = performance({}, NOW)
  expect(r.p).toBe(50)
  expect(r.c).toBe(0)
  expect(r.pEff).toBe(50)
})

test("weights renormalize inside a category and coverage reflects missing indicators", () => {
  const r = performance({ aa_coding: ind(80), aa_agentic: ind(60), aa_intelligence: ind(40) }, NOW)
  for (const [k, s, c] of [["C", 80, 0.45], ["A", 60, 0.3], ["I", 40, 0.6]] as const) {
    expect(r.categories[k].score).toBeCloseTo(s)
    expect(r.categories[k].coverage).toBeCloseTo(c)
  }
  expect(r.p).toBeCloseTo(0.55 * 80 + 0.3 * 60 + 0.15 * 40)
  expect(r.coverage).toBeCloseTo(0.55 * 0.45 + 0.3 * 0.3 + 0.15 * 0.6)
  expect(r.independence).toBe(0.7) // single origin
  expect(r.c).toBeCloseTo(r.coverage * 1 * 1 * 0.7)
  expect(r.pEff).toBeCloseTo(r.c * r.p + (1 - r.c) * 50)
})

test("I → C proxy only when coding is missing, at reduced confidence", () => {
  const r = performance({ aa_intelligence: ind(90) }, NOW)
  expect(r.categories.C.proxy).toBe(true)
  expect(r.categories.C.score).toBe(90)
  expect(r.categories.C.coverage).toBeCloseTo(0.6 * 0.3)
})

test("two independent origins raise independence; stale data decays", () => {
  const fresh = performance({ aa_coding: ind(70), tau_bench_airline: ind(70, "openrouter") }, NOW)
  expect(fresh.independence).toBe(1)
  const old = performance({ aa_coding: ind(70, "aa", 1, NOW - 180 * 86_400_000) }, NOW)
  expect(old.recency).toBeCloseTo(0.5)
})

test("a single high score from a new model cannot dominate", () => {
  const newModel = performance({ aa_intelligence: ind(100, "aa", 0.8) }, NOW)
  const solid = performance({ aa_coding: ind(70), aa_agentic: ind(70), aa_intelligence: ind(70), tau_bench_airline: ind(70, "openrouter"), gpqa_diamond: ind(70, "openrouter") }, NOW)
  expect(newModel.pEff).toBeLessThan(solid.pEff)
})

test("normalize and reference range", () => {
  expect(normalize(55, { min: 10, max: 100 })).toBe(50)
  expect(normalize(-5, { min: 0, max: 10 })).toBe(0)
  expect(normalize(5, { min: 1, max: 1 })).toBe(50)
  expect(referenceRange([1, 2, 3])).toBeUndefined()
  const r = referenceRange(Array.from({ length: 101 }, (_, i) => i))!
  expect(r).toEqual({ min: 5, max: 95 })
})

test("identity mapping for OpenRouter permaslugs and AA slugs", () => {
  expect(orBase("z-ai/glm-5.3-flash-20260826")).toBe("z-ai/glm-5.3-flash")
  expect(aaKeyOf("zhipuai/glm-5.3-flash")).toBe("glm-5-3-flash")
  const m = new BenchmarkMapper(
    [
      { canonicalID: "zhipuai/glm-5.3-flash", providerID: "nvidia", modelID: "z-ai/glm-5.3-flash" },
      { canonicalID: "cohere/command-a", providerID: "xkiro", modelID: "cohere/command-a" },
      { canonicalID: "a/dup-x", providerID: "p", modelID: "a/dup-x" },
      { canonicalID: "b/dup-x", providerID: "p", modelID: "b/dup-x" },
    ],
    { "z-ai/glm-5.3-flash": { canonical_model_id: "zhipuai/glm-5.3-flash" } },
  )
  expect(m.mapOr("z-ai/glm-5.3-flash-20260826")).toEqual({ canonicalID: "zhipuai/glm-5.3-flash", conf: 1 })
  expect(m.mapOr("cohere/command-a-20250301")).toEqual({ canonicalID: "cohere/command-a", conf: 0.8 })
  expect(m.mapAa("glm-5-3-flash")).toEqual({ canonicalID: "zhipuai/glm-5.3-flash", conf: 0.8 })
  expect(m.mapAa("dup-x")).toBeUndefined() // ambiguous → no match
  expect(m.mapAa("unknown")).toBeUndefined()
})

test("OpenRouter benchmark parsing", () => {
  const obs = parseOrBenchmarks({
    meta: { version: "v1", as_of: "2026-11-10T00:00:00Z", citation: null },
    data: [
      { source: "artificial-analysis", model_permaslug: "x/a-20260101", display_name: "A (Xhigh)", intelligence_index: 30, coding_index: 25.5, agentic_index: null },
      { source: "openrouter", model_permaslug: "x/a-20260101", benchmark_type: "tau_bench_verified_airline", accuracy: 0.66, last_run_timestamp: "2026-11-01T00:00:00Z" },
      { source: "openrouter", model_permaslug: "x/a-20260101", benchmark_type: "search_hle", accuracy: 0.1 },
      { source: "design-arena", model_permaslug: "x/a-20260101", elo: 1200 },
    ],
  })
  expect(obs.map((o) => [o.source, o.benchmark, o.raw, o.effort])).toEqual([
    ["aa", "aa_intelligence", 30, "xhigh"],
    ["aa", "aa_coding", 25.5, "xhigh"],
    ["openrouter", "tau_bench_airline", 66, undefined],
  ])
  expect(effortFromDisplayName("Claude (Max, Default Fallback)")).toBe("max")
  expect(effortFromDisplayName("Gemma 4")).toBeUndefined()
})

test("prior controls where missing evidence shrinks to", () => {
  const none = performance({}, NOW, undefined, 35)
  expect(none.p).toBe(35)
  expect(none.pEff).toBe(35)
  const some = performance({ aa_coding: ind(80) }, NOW, undefined, 35)
  expect(some.categories.A.score).toBe(35)
  expect(some.pEff).toBeCloseTo(some.c * some.p + (1 - some.c) * 35)
})

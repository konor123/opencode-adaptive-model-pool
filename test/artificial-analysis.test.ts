import { expect, test } from "bun:test"
import { AaFetchError, fetchAaModels } from "../src/benchmarks/artificial-analysis.ts"
import { aaObservations } from "../src/benchmarks/refresh.ts"

const KEY = "aa-test-KEY-1234567890"
const item = (slug: string, ii: number | null) => ({
  slug, name: slug.toUpperCase(), model_creator: { id: "x", name: "Maker" }, release_date: "2026-11-01",
  evaluations: { artificial_analysis_intelligence_index: ii, artificial_analysis_coding_index: null, artificial_analysis_agentic_index: null },
  performance: { median_output_tokens_per_second: 66.3, median_time_to_first_token_seconds: null, median_time_to_first_answer_token_seconds: 3.3, median_end_to_end_response_time_seconds: 10.8 },
})
type Page = { status: number; body?: unknown; headers?: Record<string, string> }
const seq = (pages: Page[], seen: any[] = []) =>
  (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: init?.headers, redirect: init?.redirect })
    const p = pages[Math.min(seen.length - 1, pages.length - 1)]!
    return new Response(JSON.stringify(p.body ?? {}), { status: p.status, headers: { "content-type": "application/json", ...p.headers } })
  }) as unknown as typeof fetch

test("pages until has_more is false and maps nulls to undefined", async () => {
  const seen: any[] = []
  const r = await fetchAaModels(KEY, { fetchImpl: seq([
    { status: 200, body: { intelligence_index_version: 5, pagination: { has_more: true }, data: [item("a", 30.5), { name: "no slug" }] }, headers: { "x-ratelimit-remaining": "99" } },
    { status: 200, body: { pagination: { has_more: false }, data: [item("b", null)] }, headers: { "x-ratelimit-remaining": "98" } },
  ], seen) })
  expect(r.pages).toBe(2)
  expect(r.indexVersion).toBe(5)
  expect(r.rateLimitRemaining).toBe(98)
  expect(r.models.map((m) => m.slug)).toEqual(["a", "b"])
  expect(r.models[0]).toMatchObject({ intelligenceIndex: 30.5, creator: "Maker", medianTps: 66.3, medianTtfaS: 3.3 })
  expect(r.models[0]!.codingIndex).toBeUndefined()
  expect(r.models[0]!.medianTtftS).toBeUndefined()
  expect(r.models[1]!.intelligenceIndex).toBeUndefined()
  expect(seen[0].headers["x-api-key"]).toBe(KEY)
  expect(seen[0].redirect).toBe("manual")
  expect(seen.map((s) => s.url)).toEqual([expect.stringContaining("page=1"), expect.stringContaining("page=2")])
})

test("maxPages caps requests", async () => {
  const seen: any[] = []
  const r = await fetchAaModels(KEY, { maxPages: 2, fetchImpl: seq([{ status: 200, body: { pagination: { has_more: true }, data: [item("a", 1)] } }], seen) })
  expect(seen.length).toBe(2)
  expect(r.models.length).toBe(2)
})

test("429 stops with retryAfter, 302 refused, thrown errors never carry the key", async () => {
  try {
    await fetchAaModels(KEY, { fetchImpl: seq([{ status: 429, headers: { "retry-after": "120" } }]) })
    throw new Error("expected 429")
  } catch (e: any) {
    expect(e).toBeInstanceOf(AaFetchError)
    expect(e.retryAfterS).toBe(120)
  }
  await expect(fetchAaModels(KEY, { fetchImpl: seq([{ status: 302 }]) })).rejects.toThrow(/redirect refused/)
  const throwing = (async () => { throw new Error(`net down ${KEY}`) }) as unknown as typeof fetch
  try {
    await fetchAaModels(KEY, { fetchImpl: throwing })
    throw new Error("expected failure")
  } catch (e: any) {
    expect(String(e.message)).not.toContain(KEY)
  }
})

test("AA models become observations (intelligence + speed priors)", () => {
  const obs = aaObservations([{ slug: "a", name: "A", intelligenceIndex: 30, medianTps: 60 }], 5)
  expect(obs.map((o) => [o.source, o.via, o.benchmark, o.version, o.raw])).toEqual([
    ["aa", "aa-api", "aa_intelligence", "ii-v5", 30],
    ["aa", "aa-api", "speed_tps", "ii-v5", 60],
  ])
})

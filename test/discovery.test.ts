import { expect, test } from "bun:test"
import { injectProviderModels } from "../src/discovery/config-inject.ts"
import { effectiveCatalog } from "../src/discovery/models-dev.ts"
import { applyAndSync, refreshProviderModels } from "../src/discovery/pipeline.ts"
import { fetchProviderModels, ProviderFetchError } from "../src/discovery/provider-api.ts"
import { syncRoutes } from "../src/discovery/sync.ts"
import { resolveOptions } from "../src/options.ts"
import { buildRoute } from "../src/policy/eligibility.ts"
import { acquireLease, openDb } from "../src/storage/db.ts"
import type { CatalogModel } from "../src/types.ts"

const SECRET = "sk-test-SECRET-1234567890"
const xkiroRows = [
  { id: "mistralai/ministral-3b", display_name: "Ministral 3B", modality: "chat", access_tier: "free", pricing: { input: 0, output: 0 }, capabilities: { tools: true, reasoning: false }, context_length: 128000, max_output_tokens: 8192 },
  { id: "google/gemini-x", modality: "chat", access_tier: "premium", pricing: { input: 1, output: 2 }, capabilities: { tools: true } },
  { id: "img/model", modality: "image", access_tier: "free", pricing: { input: 0, output: 0 } },
]
const fakeFetch = (status: number, body: unknown, seen?: { headers?: any; redirect?: string }) =>
  (async (_url: any, init: any) => {
    if (seen) { seen.headers = init?.headers; seen.redirect = init?.redirect }
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch

test("provider-api: free-chat filter, auth header, no redirects", async () => {
  const seen: any = {}
  const r = await fetchProviderModels("xkiro", SECRET, { filter: "free-chat" }, { fetchImpl: fakeFetch(200, { data: xkiroRows }, seen) })
  expect(r.map((x) => x.modelID)).toEqual(["mistralai/ministral-3b"])
  expect(r[0]).toMatchObject({ toolCall: true, reasoning: false, contextLimit: 128000, outputLimit: 8192, accessTier: "free", cost: { input: 0, output: 0 } })
  expect(seen.headers.Authorization).toBe(`Bearer ${SECRET}`)
  expect(seen.redirect).toBe("manual")
})

test("provider-api: failures never leak the key and keep cache semantics", async () => {
  await expect(fetchProviderModels("xkiro", SECRET, { filter: "free-chat" }, { fetchImpl: fakeFetch(302, {}) })).rejects.toThrow(/redirect refused/)
  await expect(fetchProviderModels("xkiro", SECRET, { filter: "free-chat" }, { fetchImpl: fakeFetch(200, { data: [] }) })).rejects.toThrow(/empty/)
  await expect(fetchProviderModels("evil", SECRET, {}, { fetchImpl: fakeFetch(200, {}) })).rejects.toThrow(ProviderFetchError)
  const throwing = (async () => { throw new Error(`boom ${SECRET}`) }) as unknown as typeof fetch
  try {
    await fetchProviderModels("xkiro", SECRET, {}, { fetchImpl: throwing })
    throw new Error("expected failure")
  } catch (e: any) {
    expect(String(e.message)).not.toContain(SECRET)
  }
})

test("config injection: replaces models, keeps user fields, drops a disjoint whitelist", () => {
  const cfg: any = {
    provider: {
      xkiro: { models: { "mistralai/ministral-3b": { name: "mine" }, "old/model": {} }, whitelist: ["qwen/qwen3-max:free"] },
      exaone: { models: { "k-exaone_v2.5": { tool_call: true } } },
    },
  }
  const cache: Record<string, CatalogModel[]> = {
    xkiro: [{ providerID: "xkiro", modelID: "mistralai/ministral-3b", name: "Ministral 3B", toolCall: true, source: "provider-api", accessTier: "free", cost: { input: 0, output: 0 } }],
    exaone: [{ providerID: "exaone", modelID: "k-exaone_v2.5", source: "provider-api" }],
  }
  const rep = injectProviderModels(cfg, cache)
  expect(rep).toEqual([
    { provider: "xkiro", models: 1, whitelistDropped: true },
    { provider: "exaone", models: 1, whitelistDropped: false },
  ])
  expect(Object.keys(cfg.provider.xkiro.models)).toEqual(["mistralai/ministral-3b"])
  expect(cfg.provider.xkiro.models["mistralai/ministral-3b"]).toEqual({ name: "mine", tool_call: true, cost: { input: 0, output: 0 } })
  expect(cfg.provider.xkiro.whitelist).toBeUndefined()
  expect(cfg.provider.exaone.models["k-exaone_v2.5"].tool_call).toBe(true)
  // no OAMP-private keys leak into the OpenCode config
  expect(JSON.stringify(cfg)).not.toContain("oamp")
})

test("effective catalog mirrors OpenCode filters and enriches from cache", () => {
  const dev = { openrouter: { models: {
    "a:free": { tool_call: true, cost: { input: 0, output: 0 }, canonical_model_id: "org/a" },
    "b": { tool_call: true, cost: { input: 1, output: 1 } },
    "old:free": { status: "deprecated" },
    "exp:free": { status: "alpha" },
  } } }
  const cfg = { provider: { openrouter: { whitelist: ["a:free", "b", "old:free", "exp:free"], blacklist: ["b"] }, xkiro: { models: { "x/y": { name: "Y" } } } } }
  const cache = { xkiro: [{ providerID: "xkiro", modelID: "x/y", accessTier: "free", cost: { input: 0, output: 0 }, toolCall: true, source: "provider-api" as const }] }
  const { models, covered } = effectiveCatalog(cfg, dev, ["openrouter", "xkiro", "nvidia"], false, cache)
  expect(covered).toEqual(["openrouter", "xkiro"])
  expect(models.map((x) => `${x.providerID}/${x.modelID}`)).toEqual(["openrouter/a:free", "xkiro/x/y"])
  expect(models[1]).toMatchObject({ name: "Y", accessTier: "free", toolCall: true, source: "provider-api" })
})

test("route sync: stale after one miss, retired after two, disabled preserved", () => {
  const db = openDb(":memory:")
  const o = resolveOptions({})
  const r = (id: string) => buildRoute({ providerID: "opencode", modelID: id, cost: { input: 0, output: 0 }, toolCall: true, source: "models.dev" }, o)
  expect(syncRoutes(db, [r("a-free"), r("b-free")], ["opencode"], 1)).toEqual({ added: 2, updated: 0, stale: 0, retired: 0 })
  db.query("UPDATE routes SET status='disabled' WHERE route_id='opencode/b-free'").run()
  expect(syncRoutes(db, [r("b-free")], ["opencode"], 2)).toEqual({ added: 0, updated: 1, stale: 1, retired: 0 })
  expect(syncRoutes(db, [r("b-free")], ["opencode"], 3)).toEqual({ added: 0, updated: 1, stale: 0, retired: 1 })
  const st = Object.fromEntries((db.query("SELECT route_id, status FROM routes").all() as any[]).map((x) => [x.route_id, x.status]))
  expect(st).toEqual({ "opencode/a-free": "retired", "opencode/b-free": "disabled" })
  // provider not covered this round → untouched
  expect(syncRoutes(db, [], [], 4).stale).toBe(0)
  // a retired route that comes back becomes active again
  syncRoutes(db, [r("a-free")], ["opencode"], 5)
  expect((db.query("SELECT status FROM routes WHERE route_id='opencode/a-free'").get() as any).status).toBe("active")
})

test("pipeline: leased refresh fills cache, injection exposes models, freshness respected", async () => {
  const db = openDb(":memory:")
  const o = resolveOptions({ paths: { opencodeAuth: "/nonexistent" } })
  const cfg: any = { provider: { xkiro: { options: { apiKey: "literal-key" }, whitelist: ["gone"] } } }
  const f = fakeFetch(200, { data: xkiroRows })
  const r1 = await refreshProviderModels(db, o, cfg, { fetchImpl: f, now: 1000 })
  expect(r1.xkiro).toEqual({ ok: true, count: 1 })
  expect(r1.exaone).toEqual({ ok: false, skipped: "provider not configured" })
  const r2 = await refreshProviderModels(db, o, cfg, { fetchImpl: f, now: 2000 })
  expect(r2.xkiro?.skipped).toBe("fresh")
  // another holder owns the lease → skip entirely
  acquireLease(db, "provider-sync", "other", 60_000, 3000)
  const r3 = await refreshProviderModels(db, o, cfg, { fetchImpl: f, force: true, now: 3001 })
  expect(r3._lease?.skipped).toContain("another process")
  const s = applyAndSync(db, o, cfg, {}, 4000)
  expect(s.routes).toBe(1)
  expect(s.eligible).toBe(1)
  expect(cfg.provider.xkiro.whitelist).toBeUndefined()
  const row = db.query("SELECT price_state, eligible, tools FROM routes WHERE route_id='xkiro/mistralai/ministral-3b'").get() as any
  expect(row).toEqual({ price_state: "free_verified", eligible: 1, tools: 1 })
  // DB never contains the credential
  const dump = JSON.stringify(db.query("SELECT * FROM provider_models").all()) + JSON.stringify(db.query("SELECT * FROM kv").all())
  expect(dump).not.toContain("literal-key")
})

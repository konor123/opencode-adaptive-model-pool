import { expect, test } from "bun:test"
import { canonicalOf } from "../src/identity/canonical.ts"
import { DEFAULT_OPTIONS, globMatch, resolveOptions } from "../src/options.ts"
import { buildRoute } from "../src/policy/eligibility.ts"
import { priceStateOf } from "../src/policy/price.ts"
import type { CatalogModel } from "../src/types.ts"

const P = DEFAULT_OPTIONS.policy
const m = (x: Partial<CatalogModel>): CatalogModel => ({ providerID: "p", modelID: "m", source: "models.dev", ...x })

test("price states", () => {
  expect(priceStateOf(m({ providerID: "opencode", modelID: "deepseek-v4.1-flash-free", cost: { input: 0, output: 0 } }), P)).toBe("free_verified")
  expect(priceStateOf(m({ providerID: "openrouter", modelID: "cohere/north-mini-code:free", cost: { input: 0, output: 0 } }), P)).toBe("free_verified")
  expect(priceStateOf(m({ providerID: "openrouter", modelID: "openrouter/free", cost: { input: 0, output: 0 } }), P)).toBe("free_verified")
  expect(priceStateOf(m({ providerID: "openrouter", modelID: "z-ai/glm-5.3-flash", cost: { input: 0.15, output: 0.5 } }), P)).toBe("paid")
  expect(priceStateOf(m({ providerID: "nvidia", modelID: "z-ai/glm-5.3-flash", cost: { input: 0, output: 0 } }), P)).toBe("free_quota")
  expect(priceStateOf(m({ providerID: "opencode", modelID: "big-pickle", cost: { input: 0, output: 0 } }), P)).toBe("unknown")
  expect(priceStateOf(m({ providerID: "exaone", modelID: "k-exaone_v2.5" }), P)).toBe("free_declared")
  expect(priceStateOf(m({ providerID: "xkiro", modelID: "a/b", accessTier: "free", cost: { input: 0, output: 0 } }), P)).toBe("free_verified")
  // explicit paid signal beats freeDeclared
  expect(priceStateOf(m({ providerID: "xkiro", modelID: "a/b", accessTier: "premium" }), P)).toBe("paid")
  expect(priceStateOf(m({ providerID: "xkiro", modelID: "a/b", cost: { input: 1, output: 2 } }), P)).toBe("paid")
  expect(priceStateOf(m({ providerID: "other", modelID: "x" }), P)).toBe("unknown")
})

test("eligibility reasons", () => {
  const o = resolveOptions({})
  expect(buildRoute(m({ providerID: "opencode", modelID: "a-free", cost: { input: 0, output: 0 }, toolCall: true }), o).eligible).toBe(true)
  expect(buildRoute(m({ providerID: "openrouter", modelID: "x", cost: { input: 1, output: 1 }, toolCall: true }), o).ineligibleReasons).toEqual(["price:paid"])
  expect(buildRoute(m({ providerID: "nvidia", modelID: "img", cost: { input: 0, output: 0 }, toolCall: false, outputModalities: ["image"] }), o).ineligibleReasons).toEqual(["no_tools", "no_text_output"])
  expect(buildRoute(m({ providerID: "exaone", modelID: "new" }), o).ineligibleReasons).toEqual(["tools_unknown"])
  const denied = resolveOptions({ policy: { deny: ["opencode/*"] } })
  expect(buildRoute(m({ providerID: "opencode", modelID: "a-free", cost: { input: 0, output: 0 }, toolCall: true }), denied).ineligibleReasons).toEqual(["denied"])
})

test("canonical ids", () => {
  expect(canonicalOf(m({ canonicalID: "DeepSeek/deepseek-v4.1-flash" }))).toEqual({ canonicalID: "deepseek/deepseek-v4.1-flash", matchConf: 1 })
  expect(canonicalOf(m({ providerID: "xkiro", modelID: "qwen/qwen3-max:free" }))).toEqual({ canonicalID: "qwen/qwen3-max", matchConf: 0.8 })
  expect(canonicalOf(m({ providerID: "exaone", modelID: "k-exaone_v2.5" }))).toEqual({ canonicalID: "exaone:k-exaone_v2.5", matchConf: 0.6 })
})

test("glob and option merge", () => {
  expect(globMatch("xkiro/*", "xkiro/mistralai/ministral-3b")).toBe(true)
  expect(globMatch("xkiro/*", "openrouter/xkiro/x")).toBe(false)
  const o = resolveOptions({ policy: { allowPaid: true }, storage: { path: "~/x.db" }, bogus: 1 })
  expect(o.policy.allowPaid).toBe(true)
  expect(o.policy.freeDeclared).toEqual(["xkiro/*", "exaone/*"])
  expect(o.storage.path.endsWith("/x.db") && !o.storage.path.startsWith("~")).toBe(true)
  expect((o as any).bogus).toBeUndefined()
})

test("providerSync accepts new provider keys", () => {
  const o = resolveOptions({ providerSync: { newprov: { filter: "all" } } })
  expect(Object.keys(o.providerSync)).toEqual(["xkiro", "exaone", "newprov"])
})

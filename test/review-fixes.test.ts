// Regression tests for the independent Codex review of e46aa19 (C01–C10).
import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerConnected } from "../src/discovery/models-dev.ts"
import { initLog } from "../src/log.ts"
import { resolveOptions } from "../src/options.ts"
import { recordOutcome } from "../src/scoring/health.ts"
import { computeRouteScores, eligibleForPolicy } from "../src/scoring/routes.ts"
import { Selector } from "../src/selector/hook.ts"
import { selectRoute } from "../src/selector/select.ts"
import { putSession, sha256 } from "../src/selector/state.ts"
import { openDb } from "../src/storage/db.ts"
import { LiveTelemetry } from "../src/telemetry/live.ts"
import { importUsage } from "../src/telemetry/usage-import.ts"

function routesDb() {
  const db = openDb(":memory:")
  const ins = db.query(`INSERT INTO routes (route_id, provider_id, model_id, canonical_id, match_conf, source, price_state, eligible, tools, ctx_limit, meta_json, status, first_seen, last_seen, updated_at)
    VALUES (?, ?, ?, ?, 1, 'models.dev', ?, 1, 1, 200000, ?, 'active', 0, 0, 0)`)
  ins.run("opencode/a-free", "opencode", "a-free", "x/a", "free_verified", '{"cost":{"input":0,"output":0}}')
  ins.run("openrouter/paid", "openrouter", "paid", "x/p", "paid", '{"cost":{"input":1,"output":2}}')
  ins.run("nvidia/b", "nvidia", "b", "x/b", "free_quota", '{"cost":{"input":0,"output":0}}')
  // another process synced with allowPaid=true and flagged the paid route eligible in the shared table
  db.query("UPDATE routes SET eligible = 1").run()
  db.query("INSERT INTO scores (route_id, pool, p_eff, computed_at) VALUES ('openrouter/paid','auto',95,0), ('opencode/a-free','auto',70,0), ('nvidia/b','auto',60,0)").run()
  return db
}

test("C01: eligibility is re-evaluated with this process's policy (paid + provider allowlist)", () => {
  const db = routesDb()
  const strict = resolveOptions({ providers: ["opencode", "openrouter"] })
  const ids = computeRouteScores(db, strict).filter((s) => s.pool === "auto").map((s) => s.routeID)
  expect(ids).toEqual(["opencode/a-free"]) // paid route rejected, nvidia not in this process's providers
  const lax = resolveOptions({ policy: { allowPaid: true } })
  expect(computeRouteScores(db, lax).filter((s) => s.pool === "auto").map((s) => s.routeID).sort()).toEqual(["nvidia/b", "opencode/a-free", "openrouter/paid"])
  expect(eligibleForPolicy({ provider_id: "x", model_id: "y", tools: null, meta_json: "{}" }, strict)).toBe(false)
})

test("C02: no candidates or a failing selection never leaves the marker in place", async () => {
  const db = openDb(":memory:") // empty catalog
  const sel = new Selector({ db, opts: resolveOptions({}), emergencyRoute: () => "openrouter/cohere/north-mini-code:free" })
  const out: any = { message: { model: { providerID: "oamp", modelID: "auto" } } }
  await sel.onChatMessage({ sessionID: "s", model: { providerID: "oamp", modelID: "auto" } }, out)
  expect(out.message.model).toEqual({ providerID: "openrouter", modelID: "cohere/north-mini-code:free" })
  // selection throws (e.g. storage failure) → still replaced
  const broken = new Selector({ db: { query: () => { throw new Error("db gone") } } as any, opts: resolveOptions({}), emergencyRoute: () => "opencode/a-free" })
  const out2: any = { message: { model: { providerID: "oamp", modelID: "auto" } } }
  await broken.onChatMessage({ sessionID: "s", model: { providerID: "oamp", modelID: "auto" } }, out2)
  expect(out2.message.model).toEqual({ providerID: "opencode", modelID: "a-free" })
  // a marker is never used as the emergency route
  const loop = new Selector({ db, opts: resolveOptions({}), emergencyRoute: () => "oamp/fast" })
  const out3: any = { message: { model: { providerID: "oamp", modelID: "auto" } } }
  await loop.onChatMessage({ sessionID: "s", model: { providerID: "oamp", modelID: "auto" } }, out3)
  expect(out3.message.model.providerID).toBe("oamp")
})

test("C03: a models.dev entry alone does not make a provider usable", () => {
  const dev = { nvidia: { env: ["NVIDIA_API_KEY_TEST_ONLY"], models: {} }, openrouter: { env: ["OR_TEST_ONLY"], models: {} } }
  delete process.env.NVIDIA_API_KEY_TEST_ONLY
  expect(providerConnected("nvidia", {}, dev as any, new Set())).toBe(false)
  expect(providerConnected("nvidia", {}, dev as any, new Set(["nvidia"]))).toBe(true) // auth store
  process.env.OR_TEST_ONLY = "x"
  expect(providerConnected("openrouter", {}, dev as any, new Set())).toBe(true) // env var
  delete process.env.OR_TEST_ONLY
  expect(providerConnected("xkiro", { provider: { xkiro: { options: { apiKey: "{file:/k}" } } } }, dev as any, new Set())).toBe(true)
  expect(providerConnected("opencode", {}, dev as any, new Set())).toBe(true) // public free models
  expect(providerConnected("nvidia", { disabled_providers: ["nvidia"] }, dev as any, new Set(["nvidia"]))).toBe(false)
})

test("C04: logger setup never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "oamp-log-"))
  writeFileSync(join(dir, "file"), "x")
  expect(() => initLog(join(dir, "file", "sub", "oamp.db"))).not.toThrow()
})

test("C05: an inherited route that was never used must respect maxSessions", () => {
  const rs = (id: string, r: number, extra = {}) => ({ routeID: id, providerID: id.split("/")[0]!, modelID: id.split("/")[1]!, pool: "auto",
    pEff: r, l: 50, h: 1, r, samples: 10, health: { state: "healthy" as const, selectable: true as const }, ...extra })
  const c = [rs("exaone/k", 90, { maxSessions: 1 }), rs("o/x", 70)]
  const ctx = { now: 1, activeSessions: () => 1, switchMargin: 5, switchHoldMs: 1, explorationBudget: 0, rand: () => 1 }
  // child inherited exaone (turns 0) while the parent holds the only slot → elsewhere, reason "limit"
  expect(selectRoute(c, { pool: "auto", routeID: "exaone/k", turns: 0 }, ctx)).toMatchObject({ routeID: "o/x", reason: "limit" })
  // the session that already uses it keeps its slot
  expect(selectRoute(c, { pool: "auto", routeID: "exaone/k", turns: 3 }, ctx)).toMatchObject({ routeID: "exaone/k", reason: "sticky" })
})

test("C06: importing history does not overwrite live timing; C07: live rows are stamped at completion", () => {
  const { Database } = require("bun:sqlite")
  const dir = mkdtempSync(join(tmpdir(), "oamp-merge-"))
  const p = join(dir, "opencode.db")
  const src = new Database(p, { create: true })
  src.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);")
  src.prepare("INSERT INTO message VALUES (?,?,?,?)").run("m1", "s1", 900, JSON.stringify({ role: "assistant", providerID: "p", modelID: "x", time: { created: 900, completed: 5100 }, tokens: { output: 150 }, finish: "stop" }))
  src.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p1", "m1", "s1", 1000, JSON.stringify({ type: "tool", tool: "read", state: { status: "completed" } }))
  src.close()
  const db = openDb(":memory:")
  let t = 1000
  const lt = new LiveTelemetry(db, () => t)
  lt.onEvent({ type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant", providerID: "p", modelID: "x", time: { created: 900 } } } })
  lt.onHeaders("s1", "build")
  t = 3100; lt.onEvent({ type: "message.part.updated", properties: { part: { messageID: "m1", type: "text" } } })
  t = 5100; lt.onEvent({ type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant", providerID: "p", modelID: "x", time: { created: 900, completed: 5100 }, tokens: { output: 150 }, finish: "stop" } } })
  const live = db.query("SELECT ts, e2e_ms, tps FROM request_metrics").get() as any
  expect(live.ts).toBe(5100)
  expect(live.e2e_ms).toBe(4100)
  importUsage(db, p)
  const merged = db.query("SELECT kind, ts, e2e_ms, tps, tool_calls FROM request_metrics").get() as any
  expect(merged).toMatchObject({ kind: "primary", ts: 5100, e2e_ms: 4100, tool_calls: 1 })
  expect(merged.tps).toBeCloseTo(live.tps)
})

test("C08: a failure recorded by another process is seen at the next decision despite the score cache", async () => {
  const db = openDb(":memory:")
  const ins = db.query(`INSERT INTO routes (route_id, provider_id, model_id, canonical_id, match_conf, source, price_state, eligible, tools, ctx_limit, meta_json, status, first_seen, last_seen, updated_at)
    VALUES (?, ?, ?, ?, 1, 'models.dev', 'free_verified', 1, 1, 200000, '{"cost":{"input":0,"output":0}}', 'active', 0, 0, 0)`)
  ins.run("opencode/a-free", "opencode", "a-free", "x/a"); ins.run("opencode/b-free", "opencode", "b-free", "x/b")
  db.query("INSERT INTO scores (route_id, pool, p_eff, computed_at) VALUES ('opencode/a-free','auto',90,0), ('opencode/b-free','auto',60,0)").run()
  const now = 1_800_000_000_000
  const a = new Selector({ db, opts: resolveOptions({}), now: () => now, rand: () => 1 })
  const o1: any = { message: { model: { providerID: "oamp", modelID: "auto" } } }
  await a.onChatMessage({ sessionID: "s1", model: { providerID: "oamp", modelID: "auto" } }, o1)
  expect(o1.message.model.modelID).toBe("a-free") // scores now cached in process A
  recordOutcome(db, "opencode/a-free", "rate_limit", now) // written by process B
  const o2: any = { message: { model: { providerID: "oamp", modelID: "auto" } } }
  await a.onChatMessage({ sessionID: "s2", model: { providerID: "oamp", modelID: "auto" } }, o2)
  expect(o2.message.model.modelID).toBe("b-free")
})

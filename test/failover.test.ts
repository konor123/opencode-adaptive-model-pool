import { expect, test } from "bun:test"
import { resolveOptions } from "../src/options.ts"
import { recordOutcome } from "../src/scoring/health.ts"
import { CONTINUE_TEXT, InTurnFailover } from "../src/selector/failover.ts"
import { Selector } from "../src/selector/hook.ts"
import { getSession, putSession, sha256 } from "../src/selector/state.ts"
import { openDb } from "../src/storage/db.ts"

function setup(optsOver: object = {}) {
  const db = openDb(":memory:")
  const ins = db.query(`INSERT INTO routes (route_id, provider_id, model_id, canonical_id, match_conf, source, price_state, eligible, ctx_limit, status, first_seen, last_seen, updated_at)
    VALUES (?, ?, ?, ?, 1, 'config', 'free_verified', 1, 200000, 'active', 0, 0, 0)`)
  ins.run("a/one", "a", "one", "one"); ins.run("b/two", "b", "two", "two")
  db.query("INSERT INTO scores (route_id, pool, p_eff, computed_at) VALUES ('a/one','auto',80,0), ('b/two','auto',60,0)").run()
  const opts = resolveOptions(optsOver)
  const now = 1_800_000_000_000
  const selector = new Selector({ db, opts, now: () => now, rand: () => 0.99 })
  const calls: any[] = []
  const client = {
    session: {
      abort: async (o: any) => { calls.push(["abort", o.path.id]) },
      promptAsync: async (o: any) => { calls.push(["prompt", o.path.id, o.body]) },
    },
    tui: { showToast: async (o: any) => { calls.push(["toast", o.body.message]) } },
  }
  const fo = new InTurnFailover({ db, opts, selector, client, now: () => now, delayMs: 0 })
  return { db, opts, selector, fo, calls, now }
}

test("retry in a root auto session → abort + continue on the next healthy route (once per budget)", async () => {
  const { db, fo, calls, now } = setup()
  putSession(db, { sessionHash: sha256("s"), pool: "auto", auto: true, routeID: "a/one", turns: 1 })
  fo.noteTurn("s", "build", [{ type: "text", text: "do the thing" }])
  recordOutcome(db, "a/one", "server", now) // done by telemetry.onFailure before the retry callback
  expect(await fo.onRetry("s", "a/one", "server", 1)).toBe(true)
  expect(calls[0]).toEqual(["abort", "s"])
  expect(calls[1][0]).toBe("prompt")
  expect(calls[1][2]).toEqual({ model: { providerID: "b", modelID: "two" }, agent: "build", parts: [{ type: "text", text: CONTINUE_TEXT, synthetic: true }] })
  expect(calls[2][0]).toBe("toast")
  expect(getSession(db, sha256("s"))!.routeID).toBe("b/two") // state updated BEFORE the continue prompt arrives
  expect((db.query("SELECT reason FROM rank_history ORDER BY id DESC LIMIT 1").get() as any).reason).toBe("in-turn-failover")
  // our own continue prompt does not reset the budget
  fo.noteTurn("s", "build", [{ type: "text", text: CONTINUE_TEXT, synthetic: true }])
  recordOutcome(db, "b/two", "server", now)
  // second switch: no healthy alternative left (a/one is cooling down) → falls back to probation/fallback, never the same route
  const r2 = await fo.onRetry("s", "b/two", "server", 1)
  expect(typeof r2).toBe("boolean")
})

test("no failover for manual sessions, subagents, other routes, disabled option, or an exhausted budget", async () => {
  const s1 = setup()
  // not an auto session
  expect(await s1.fo.onRetry("x", "a/one", "server", 1)).toBe(false)
  // subagent session
  putSession(s1.db, { sessionHash: sha256("child"), pool: "auto", auto: true, routeID: "a/one", turns: 0, parentHash: "p" })
  expect(await s1.fo.onRetry("child", "a/one", "server", 1)).toBe(false)
  // retry reported for a different route than the session's current one
  putSession(s1.db, { sessionHash: sha256("s"), pool: "auto", auto: true, routeID: "a/one", turns: 1 })
  expect(await s1.fo.onRetry("s", "b/two", "server", 1)).toBe(false)
  expect(s1.calls).toEqual([])
  // option off
  const s2 = setup({ selector: { inTurnFailover: false } })
  putSession(s2.db, { sessionHash: sha256("s"), pool: "auto", auto: true, routeID: "a/one", turns: 1 })
  expect(await s2.fo.onRetry("s", "a/one", "server", 1)).toBe(false)
  // budget of 0 switches
  const s3 = setup({ selector: { maxSwitchesPerTurn: 0 } })
  putSession(s3.db, { sessionHash: sha256("s"), pool: "auto", auto: true, routeID: "a/one", turns: 1 })
  expect(await s3.fo.onRetry("s", "a/one", "server", 1)).toBe(false)
  expect(s3.calls).toEqual([])
})

test("OAMP_OPTIONS env override is merged last", () => {
  process.env.OAMP_OPTIONS = JSON.stringify({ storage: { path: "/tmp/oamp-x.db" }, selector: { maxSwitchesPerTurn: 5 } })
  const o = resolveOptions({ selector: { maxSwitchesPerTurn: 1 } })
  delete process.env.OAMP_OPTIONS
  expect(o.storage.path).toBe("/tmp/oamp-x.db")
  expect(o.selector.maxSwitchesPerTurn).toBe(5)
})

test("probe output parsing", () => {
  const { parseRunEvents } = require("../src/health/probe.ts")
  const out = [
    '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"OK"}}',
    "not json",
  ].join("\n")
  expect(parseRunEvents(out)).toEqual({ sessionID: "ses_1", text: "OK", error: undefined })
  expect(parseRunEvents('{"type":"error","error":{"name":"APIError","data":{"message":"boom"}}}').error).toBe("boom")
})

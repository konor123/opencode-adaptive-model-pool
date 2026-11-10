import { expect, test } from "bun:test"
import { resolveOptions } from "../src/options.ts"
import { healthOf } from "../src/scoring/health.ts"
import { availability, DEFAULT_LATENCY_REFS, latencyScore, scoreHigherBetter, scoreLowerBetter } from "../src/scoring/latency.ts"
import type { RouteScore } from "../src/scoring/routes.ts"
import { Selector } from "../src/selector/hook.ts"
import { selectRoute } from "../src/selector/select.ts"
import { getSession, sha256 } from "../src/selector/state.ts"
import { openDb } from "../src/storage/db.ts"
import { LiveTelemetry } from "../src/telemetry/live.ts"

const W = { ttfa: 0.35, e2e: 0.45, tps: 0.2, ewmaAlpha: 0.25, priorWeight: 10 }

test("latency sub-scores are log-scaled and shrink toward the prior", () => {
  expect(scoreLowerBetter(500, { min: 500, max: 30000 })).toBeCloseTo(100)
  expect(scoreLowerBetter(30000, { min: 500, max: 30000 })).toBeCloseTo(0)
  expect(scoreHigherBetter(200, { min: 10, max: 200 })).toBeCloseTo(100)
  expect(latencyScore([], DEFAULT_LATENCY_REFS, W).l).toBe(50)
  const fast = Array.from({ length: 40 }, (_, i) => ({ ts: i, ttfaMs: 800, e2eMs: 2000, tps: 150 }))
  const r = latencyScore(fast, DEFAULT_LATENCY_REFS, W)
  expect(r.n).toBe(40)
  expect(r.lObs!).toBeGreaterThan(80)
  expect(r.l).toBeCloseTo((40 * r.lObs! + 10 * 50) / 50)
  // few samples barely move L
  expect(latencyScore(fast.slice(0, 1), DEFAULT_LATENCY_REFS, W).l).toBeLessThan(55)
})

test("availability H: failures pull it down, floor at 0.25, few samples blend with prior", () => {
  expect(availability(Array(50).fill({ ok: true })).h).toBeCloseTo(1)
  expect(availability(Array(50).fill({ ok: false })).h).toBeCloseTo(0.25)
  expect(availability([]).h).toBeCloseTo(0.81)
  const flaky = availability(Array.from({ length: 50 }, (_, i) => ({ ok: i % 3 !== 0 })))
  expect(flaky.h).toBeLessThan(0.6)
})

test("health: transient errors cool down exponentially, permanent ones disable for a day", () => {
  const now = 1_000_000_000
  expect(healthOf([], now)).toEqual({ ok: true })
  expect(healthOf([{ ts: now - 10_000, outcome: "error", errorClass: "rate_limit" }], now)).toMatchObject({ ok: false, reason: "cooldown" })
  expect(healthOf([{ ts: now - 61_000, outcome: "error", errorClass: "rate_limit" }], now)).toEqual({ ok: true })
  const three = [0, 1, 2].map((i) => ({ ts: now - 100_000 - i, outcome: "error" as const, errorClass: "server" }))
  expect(healthOf(three, now)).toMatchObject({ ok: false, reason: "cooldown" }) // 240 s window
  expect(healthOf([{ ts: now - 3_600_000, outcome: "error", errorClass: "forbidden" }], now)).toMatchObject({ ok: false, reason: "disabled" })
  expect(healthOf([{ ts: now - 5000, outcome: "aborted" }, { ts: now - 6000, outcome: "ok" }], now)).toEqual({ ok: true })
})

const rs = (routeID: string, r: number, extra: Partial<RouteScore> = {}): RouteScore => ({
  routeID, providerID: routeID.split("/")[0]!, modelID: routeID.split("/").slice(1).join("/"), pool: "auto",
  pEff: r, l: 50, h: 1, r, samples: 50, health: { ok: true }, ...extra,
})
const ctx = (over: Partial<Parameters<typeof selectRoute>[2]> = {}) => ({
  now: 10_000_000, activeSessions: () => 0, switchMargin: 5, switchHoldMs: 30 * 60_000, explorationBudget: 0, rand: () => 0.99, ...over,
})

test("selection: best first, sticky, hold before switching, failover, context, limits, fallback", () => {
  const c = [rs("a/x", 70), rs("b/y", 60), rs("c/z", 50)]
  expect(selectRoute(c, { pool: "auto", turns: 0 }, ctx())).toMatchObject({ routeID: "a/x", reason: "best" })
  // sticky within margin
  expect(selectRoute(c, { pool: "auto", routeID: "b/y", turns: 3 }, ctx({ switchMargin: 15 }))).toMatchObject({ routeID: "b/y", reason: "sticky" })
  // better by > margin: first wait, then switch after the hold
  const pend = selectRoute(c, { pool: "auto", routeID: "b/y", turns: 3 }, ctx())
  expect(pend).toMatchObject({ routeID: "b/y", reason: "sticky-pending", betterSince: 10_000_000 })
  expect(selectRoute(c, { pool: "auto", routeID: "b/y", betterSince: 10_000_000 - 31 * 60_000, turns: 4 }, ctx())).toMatchObject({ routeID: "a/x", reason: "switch-better" })
  // current route unhealthy → failover
  const sick = [rs("a/x", 70), rs("b/y", 60, { health: { ok: false, reason: "cooldown", until: 0 } })]
  expect(selectRoute(sick, { pool: "auto", routeID: "b/y", turns: 3 }, ctx())).toMatchObject({ routeID: "a/x", reason: "failover" })
  // context too large for current route
  const small = [rs("a/x", 70), rs("b/y", 80, { ctxLimit: 32000 })]
  expect(selectRoute(small, { pool: "auto", routeID: "b/y", turns: 3 }, ctx({ estInputTokens: 30000 }))).toMatchObject({ routeID: "a/x", reason: "context" })
  // maxSessions: a busy limited route is skipped for a new session
  const lim = [rs("ex/one", 90, { maxSessions: 1 }), rs("b/y", 60)]
  expect(selectRoute(lim, { pool: "auto", turns: 0 }, ctx({ activeSessions: () => 1 }))).toMatchObject({ routeID: "b/y" })
  expect(selectRoute(lim, { pool: "auto", routeID: "ex/one", turns: 2 }, ctx({ activeSessions: () => 1 }))).toMatchObject({ routeID: "ex/one" })
  // nothing viable → never keep the marker
  const dead = [rs("a/x", 70, { health: { ok: false, reason: "cooldown", until: 0 } })]
  expect(selectRoute(dead, { pool: "auto", turns: 0 }, ctx())).toMatchObject({ routeID: "a/x", reason: "fallback" })
})

test("exploration only picks low-sample routes that are not known to be weak", () => {
  const c = [rs("a/x", 70), rs("new/m", 65, { samples: 0 }), rs("weak/m", 20, { samples: 0 })]
  const d = selectRoute(c, { pool: "auto", turns: 0 }, ctx({ explorationBudget: 1, rand: () => 0 }))
  expect(d).toMatchObject({ routeID: "new/m", reason: "explore" })
})

function seedRoutes(db: ReturnType<typeof openDb>) {
  const ins = db.query(`INSERT INTO routes (route_id, provider_id, model_id, canonical_id, match_conf, source, price_state, eligible, ctx_limit, status, first_seen, last_seen, updated_at)
    VALUES (?, ?, ?, ?, 1, 'config', 'free_verified', 1, 200000, 'active', 0, 0, 0)`)
  ins.run("opencode/good-free", "opencode", "good-free", "org/good")
  ins.run("xkiro/org/ok", "xkiro", "org/ok", "org/ok")
  db.query("INSERT INTO scores (route_id, pool, p_eff, computed_at) VALUES ('opencode/good-free','auto',80,0), ('xkiro/org/ok','auto',50,0)").run()
}

test("selector hook: marker → real route, sticky across turns, manual pick turns auto off, subagents inherit", async () => {
  const db = openDb(":memory:")
  seedRoutes(db)
  const opts = resolveOptions({})
  let now = 1_800_000_000_000
  const sel = new Selector({ db, opts, now: () => now, rand: () => 0.99 })
  const out: any = { message: { model: { providerID: "oamp", modelID: "auto" } } }
  await sel.onChatMessage({ sessionID: "ses_1", model: { providerID: "oamp", modelID: "auto" } }, out)
  expect(out.message.model).toEqual({ providerID: "opencode", modelID: "good-free" })
  expect(getSession(db, sha256("ses_1"))).toMatchObject({ pool: "auto", auto: true, routeID: "opencode/good-free", turns: 1 })
  // next turn arrives with the real model (TUI follows the last message) → still auto, sticky
  now += 1000
  const out2: any = { message: { model: { providerID: "opencode", modelID: "good-free" } } }
  await sel.onChatMessage({ sessionID: "ses_1", model: { providerID: "opencode", modelID: "good-free" } }, out2)
  expect(out2.message.model.modelID).toBe("good-free")
  expect(getSession(db, sha256("ses_1"))!.turns).toBe(2)
  // subagent created from the auto session inherits auto mode
  sel.onSessionCreated("ses_child", "ses_1")
  expect(getSession(db, sha256("ses_child"))).toMatchObject({ auto: true, routeID: "opencode/good-free", parentHash: sha256("ses_1") })
  // user picks another real model → manual wins, no rewrite
  const out3: any = { message: { model: { providerID: "xkiro", modelID: "org/ok" } } }
  await sel.onChatMessage({ sessionID: "ses_1", model: { providerID: "xkiro", modelID: "org/ok" } }, out3)
  expect(out3.message.model).toEqual({ providerID: "xkiro", modelID: "org/ok" })
  expect(getSession(db, sha256("ses_1"))!.auto).toBe(false)
  // sessions that never used a marker are untouched
  const out4: any = { message: { model: { providerID: "xkiro", modelID: "org/ok" } } }
  await sel.onChatMessage({ sessionID: "ses_other", model: { providerID: "xkiro", modelID: "org/ok" } }, out4)
  expect(getSession(db, sha256("ses_other"))).toBeUndefined()
  expect((db.query("SELECT count(*) n FROM rank_history").get() as any).n).toBe(2)
})

test("selector hook: a recorded rate limit moves the session to another route on the next turn", async () => {
  const db = openDb(":memory:")
  seedRoutes(db)
  const opts = resolveOptions({})
  let now = 1_800_000_000_000
  const sel = new Selector({ db, opts, now: () => now, rand: () => 0.99 })
  const mk = () => ({ message: { model: { providerID: "oamp", modelID: "auto" } } }) as any
  const o1 = mk()
  await sel.onChatMessage({ sessionID: "s", model: { providerID: "oamp", modelID: "auto" } }, o1)
  expect(o1.message.model.modelID).toBe("good-free")
  db.query("INSERT INTO request_metrics (ts, route_id, kind, outcome, error_class) VALUES (?, 'opencode/good-free', 'primary', 'error', 'rate_limit')").run(now)
  sel.invalidate()
  now += 5000
  const o2 = mk()
  await sel.onChatMessage({ sessionID: "s", model: { providerID: "oamp", modelID: "auto" } }, o2)
  expect(o2.message.model).toEqual({ providerID: "xkiro", modelID: "org/ok" })
  const last = db.query("SELECT reason FROM rank_history ORDER BY id DESC LIMIT 1").get() as any
  expect(last.reason).toBe("failover")
})

test("live telemetry binds chat.headers start to the next assistant step and measures TTFT/TTFA/E2E", () => {
  const db = openDb(":memory:")
  let t = 1000
  const lt = new LiveTelemetry(db, () => t)
  // assistant message is created slightly before the request starts (Phase 0 E9)
  lt.onEvent({ type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant", providerID: "p", modelID: "x", time: { created: 900 } } } })
  t = 1000; lt.onHeaders("s1", "build")
  t = 1100; lt.onHeaders("s1", "title") // ignored
  t = 3000; lt.onEvent({ type: "message.part.updated", properties: { part: { messageID: "m1", type: "step-start" } } })
  t = 3100; lt.onEvent({ type: "message.part.updated", properties: { part: { messageID: "m1", type: "reasoning" } } })
  t = 3600; lt.onEvent({ type: "message.part.updated", properties: { part: { messageID: "m1", type: "text" } } })
  t = 4000; lt.onEvent({ type: "message.part.updated", properties: { part: { messageID: "u9", type: "text" } } }) // unknown/user message
  t = 5100
  lt.onEvent({ type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant", providerID: "p", modelID: "x",
    time: { created: 900, completed: 5100 }, tokens: { input: 3000, output: 100, reasoning: 50 }, finish: "stop" } } })
  const row = db.query("SELECT * FROM request_metrics").get() as any
  expect(row).toMatchObject({ route_id: "p/x", kind: "primary", ttft_ms: 2100, ttfa_ms: 2600, e2e_ms: 4100, out_tokens: 150, outcome: "ok", finish: "stop", in_bucket: "2-16k" })
  expect(row.tps).toBeCloseTo(150 / 2.0)
  expect(row.session_hash).toBe(sha256("s1"))
  // errors are recorded with their class
  lt.onEvent({ type: "message.updated", properties: { info: { id: "m2", sessionID: "s1", role: "assistant", providerID: "p", modelID: "x",
    time: { created: 6000 }, error: { name: "APIError", data: { statusCode: 429 } } } } })
  expect((db.query("SELECT outcome, error_class FROM request_metrics WHERE outcome = 'error'").get() as any)).toEqual({ outcome: "error", error_class: "rate_limit" })
})

test("live telemetry records OpenCode retries as failures of the session's current route", () => {
  const db = openDb(":memory:")
  const lt = new LiveTelemetry(db, () => 5000)
  const seen: string[] = []
  lt.onFailure = (r, c) => seen.push(`${r}:${c}`)
  lt.onEvent({ type: "session.status", properties: { sessionID: "s1", status: { type: "retry", attempt: 1, message: "x" } } }) // no route yet → ignored
  lt.onEvent({ type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant", providerID: "nvidia", modelID: "a/b", time: { created: 1 } } } })
  lt.onEvent({ type: "session.status", properties: { sessionID: "s1", status: { type: "retry", attempt: 1, message: "Internal server error" } } })
  lt.onEvent({ type: "session.status", properties: { sessionID: "s1", status: { type: "retry", attempt: 2, message: "Rate limit exceeded" } } })
  const rows = db.query("SELECT route_id, outcome, error_class, attempt_no FROM request_metrics ORDER BY id").all()
  expect(rows).toEqual([
    { route_id: "nvidia/a/b", outcome: "error", error_class: "server", attempt_no: 1 },
    { route_id: "nvidia/a/b", outcome: "error", error_class: "rate_limit", attempt_no: 2 },
  ])
  expect(seen).toEqual(["nvidia/a/b:server", "nvidia/a/b:rate_limit"])
})

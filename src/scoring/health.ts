// Route health state machine (plan v1.3 §6.2–6.3). Persisted in `health_states`, shared by all OpenCode processes.
//
//   healthy ──transient failure──▶ cooldown (60→120→240→300 s)
//      ▲                              │ 3rd consecutive failure
//      │ success                      ▼
//   probation ◀──expiry── open (120 s, doubling on every re-open, max 30 min)
//      ▲                              ▲
//      └───────expiry─── disabled ◀── 401/403/404 (24 h; 401 disables the whole provider)
//
// probation: selectable only when nothing healthy fits, or as the first-turn exploration pick; success → healthy,
// failure → open again with a doubled window.
import type { Db } from "../storage/db.ts"

export type HealthState = "healthy" | "cooldown" | "open" | "disabled" | "probation"

export interface HealthRow {
  routeID: string
  state: HealthState
  errorClass?: string
  consecutiveFail: number
  opens: number
  until?: number
  lastErrorAt?: number
  lastOkAt?: number
}

export interface HealthVerdict {
  state: HealthState
  /** true = normal candidate, "probation" = only as a last resort / exploration, false = excluded */
  selectable: true | false | "probation"
  until?: number
}

const TRANSIENT = new Set(["rate_limit", "server", "timeout", "other", "bad_request"])
const PERMANENT = new Set(["auth", "forbidden", "not_found"])
export const COOLDOWN_BASE_MS = 60_000
export const COOLDOWN_MAX_MS = 300_000
export const OPEN_AFTER = 3
export const OPEN_BASE_MS = 120_000
export const OPEN_MAX_MS = 30 * 60_000
export const DISABLE_MS = 24 * 3_600_000

export function verdict(row: HealthRow | undefined, now: number): HealthVerdict {
  if (!row || row.state === "healthy") return { state: "healthy", selectable: true }
  if (row.state === "probation") return { state: "probation", selectable: "probation" }
  if (row.until !== undefined && now >= row.until) return { state: "probation", selectable: "probation" }
  return { state: row.state, selectable: false, until: row.until }
}

const openWindow = (opens: number) => Math.min(OPEN_MAX_MS, OPEN_BASE_MS * 2 ** (opens - 1))

/** Pure transition. `failure` undefined = success. */
export function transition(prev: HealthRow | undefined, routeID: string, failure: string | undefined, now: number): HealthRow {
  const cur: HealthRow = prev ? { ...prev } : { routeID, state: "healthy", consecutiveFail: 0, opens: 0 }
  const effective = verdict(cur, now).state // lazily expire to probation
  if (failure === undefined) {
    return {
      ...cur, state: "healthy", consecutiveFail: 0, errorClass: undefined, until: undefined, lastOkAt: now,
      // a route that recovered from probation keeps some memory so a relapse re-opens for longer
      opens: effective === "probation" ? cur.opens : 0,
    }
  }
  if (PERMANENT.has(failure)) {
    return { ...cur, state: "disabled", errorClass: failure, lastErrorAt: now, until: now + DISABLE_MS, consecutiveFail: cur.consecutiveFail + 1 }
  }
  if (!TRANSIENT.has(failure)) return cur // aborted / context_overflow are not health signals
  const k = cur.consecutiveFail + 1
  if (effective === "probation" || k >= OPEN_AFTER) {
    const opens = cur.opens + 1
    return { ...cur, state: "open", errorClass: failure, lastErrorAt: now, opens, consecutiveFail: k, until: now + openWindow(opens) }
  }
  return { ...cur, state: "cooldown", errorClass: failure, lastErrorAt: now, consecutiveFail: k, until: now + Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (k - 1)) }
}

export function loadHealth(db: Db): Map<string, HealthRow> {
  const out = new Map<string, HealthRow>()
  for (const r of db.query("SELECT * FROM health_states").all() as any[]) {
    let extra: { c?: string; o?: number } = {}
    try {
      extra = JSON.parse(r.error_class ?? "{}")
    } catch {}
    out.set(r.route_id, {
      routeID: r.route_id, state: r.state, errorClass: extra.c, consecutiveFail: r.consecutive_fail, opens: extra.o ?? 0,
      until: r.cooldown_until ?? undefined, lastErrorAt: r.last_error_at ?? undefined, lastOkAt: r.last_ok_at ?? undefined,
    })
  }
  return out
}

function save(db: Db, h: HealthRow) {
  db.query(`INSERT INTO health_states (route_id, state, error_class, consecutive_fail, cooldown_until, last_error_at, last_ok_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(route_id) DO UPDATE SET state = excluded.state, error_class = excluded.error_class, consecutive_fail = excluded.consecutive_fail,
              cooldown_until = excluded.cooldown_until, last_error_at = excluded.last_error_at, last_ok_at = excluded.last_ok_at`)
    .run(h.routeID, h.state, JSON.stringify({ c: h.errorClass, o: h.opens }), h.consecutiveFail, h.until ?? null, h.lastErrorAt ?? null, h.lastOkAt ?? null)
}

/** Record one outcome for a route (and, for 401, every route of the same provider). Returns the new row. */
export function recordOutcome(db: Db, routeID: string, failure: string | undefined, now = Date.now()): HealthRow {
  let next!: HealthRow
  db.transaction(() => {
    const all = loadHealth(db)
    next = transition(all.get(routeID), routeID, failure, now)
    save(db, next)
    if (failure === "auth") {
      const provider = routeID.split("/")[0]
      const siblings = db.query("SELECT route_id FROM routes WHERE provider_id = ? AND route_id != ?").all(provider, routeID) as { route_id: string }[]
      for (const s of siblings) save(db, transition(all.get(s.route_id), s.route_id, "auth", now))
    }
  }).immediate()
  return next
}

// Selector session state in SQLite (shared by all OpenCode processes on the host).
import type { Db } from "../storage/db.ts"

export const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex")

export interface StoredSession {
  sessionHash: string
  pool: string
  auto: boolean
  routeID?: string
  betterSince?: number
  turns: number
  parentHash?: string
}

export function getSession(db: Db, sessionHash: string): StoredSession | undefined {
  const r = db.query("SELECT * FROM session_routes WHERE session_hash = ?").get(sessionHash) as any
  if (!r) return undefined
  return { sessionHash, pool: r.pool, auto: !!r.auto, routeID: r.route_id ?? undefined, betterSince: r.better_since ?? undefined, turns: r.turns, parentHash: r.parent_hash ?? undefined }
}

export function putSession(db: Db, s: StoredSession, now = Date.now()): void {
  db.query(`INSERT INTO session_routes (session_hash, pool, auto, route_id, better_since, turns, parent_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_hash) DO UPDATE SET pool = excluded.pool, auto = excluded.auto, route_id = excluded.route_id,
              better_since = excluded.better_since, turns = excluded.turns, parent_hash = COALESCE(excluded.parent_hash, session_routes.parent_hash),
              updated_at = excluded.updated_at`)
    .run(s.sessionHash, s.pool, s.auto ? 1 : 0, s.routeID ?? null, s.betterSince ?? null, s.turns, s.parentHash ?? null, now, now)
}

/** Auto sessions that used a route within the window (for routeLimits.maxSessions). */
export function activeSessionsOn(db: Db, routeID: string, exceptHash: string, now = Date.now(), windowMs = 10 * 60_000): number {
  return (db.query("SELECT count(*) n FROM session_routes WHERE route_id = ? AND auto = 1 AND session_hash != ? AND updated_at >= ?")
    .get(routeID, exceptHash, now - windowMs) as { n: number }).n
}

/** Last known prompt size of a session (next request is at least this large). */
export function lastInputTokens(db: Db, sessionHash: string): number | undefined {
  const r = db.query("SELECT in_tokens FROM request_metrics WHERE session_hash = ? AND in_tokens IS NOT NULL ORDER BY ts DESC LIMIT 1").get(sessionHash) as { in_tokens: number } | null
  return r?.in_tokens ?? undefined
}

export function recordDecision(db: Db, pool: string, sessionHash: string, routeID: string, top: unknown, reason: string, now = Date.now()) {
  db.query("INSERT INTO rank_history (ts, pool, session_hash, chosen_route, top4_json, reason) VALUES (?, ?, ?, ?, ?, ?)")
    .run(now, pool, sessionHash, routeID, JSON.stringify(top), reason)
}

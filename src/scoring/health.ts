// Minimal health gate for Phase 3 (full circuit breaker + probes in Phase 4, plan v1.3 §6.2–6.3).
// Decided from the most recent outcomes of a route (newest first).

export interface Outcome {
  ts: number
  outcome: "ok" | "error" | "aborted"
  errorClass?: string | null
}

export type HealthVerdict = { ok: true } | { ok: false; reason: "cooldown" | "disabled"; until: number }

const TRANSIENT = new Set(["rate_limit", "server", "timeout", "other", "bad_request"])
const PERMANENT = new Set(["auth", "forbidden", "not_found"])
export const COOLDOWN_BASE_MS = 60_000
export const COOLDOWN_MAX_MS = 300_000
export const DISABLE_MS = 24 * 3_600_000

export function healthOf(recentNewestFirst: Outcome[], now: number): HealthVerdict {
  const rows = recentNewestFirst.filter((o) => o.outcome !== "aborted")
  if (!rows.length || rows[0]!.outcome === "ok") return { ok: true }
  const head = rows[0]!
  if (head.errorClass && PERMANENT.has(head.errorClass)) {
    const until = head.ts + DISABLE_MS
    return now < until ? { ok: false, reason: "disabled", until } : { ok: true }
  }
  let k = 0
  for (const r of rows) {
    if (r.outcome === "error" && (!r.errorClass || TRANSIENT.has(r.errorClass))) k++
    else break
  }
  if (k === 0) return { ok: true }
  const until = head.ts + Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (k - 1))
  return now < until ? { ok: false, reason: "cooldown", until } : { ok: true }
}

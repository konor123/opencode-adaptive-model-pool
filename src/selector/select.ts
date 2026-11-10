// Turn-level route selection (plan v1.3 §3.6, §5.6). Pure: all state comes in, the decision goes out.
import type { RouteScore } from "../scoring/routes.ts"

export interface SessionState {
  pool: string
  routeID?: string
  betterSince?: number
  turns: number
}

export interface SelectContext {
  now: number
  estInputTokens?: number
  activeSessions: (routeID: string) => number
  switchMargin: number
  switchHoldMs: number
  explorationBudget: number
  rand: () => number
}

export interface Decision {
  routeID: string
  reason: "best" | "explore" | "sticky" | "sticky-pending" | "switch-better" | "failover" | "context" | "limit" | "probation" | "fallback"
  betterSince?: number
  top: { routeID: string; r: number }[]
}

const fits = (c: RouteScore, tokens?: number) => !tokens || !c.ctxLimit || tokens * 1.2 <= c.ctxLimit

export function selectRoute(cands: RouteScore[], state: SessionState, ctx: SelectContext): Decision {
  const sorted = [...cands].sort((a, b) => b.r - a.r || b.pEff - a.pEff || a.routeID.localeCompare(b.routeID))
  const top = sorted.slice(0, 4).map((c) => ({ routeID: c.routeID, r: Math.round(c.r * 10) / 10 }))
  // a session that already used a route keeps its slot; an inherited route that was never used must pass the limit (review C05)
  const ownsSlot = (c: RouteScore) => c.routeID === state.routeID && state.turns > 0
  const withinSessions = (c: RouteScore) => ownsSlot(c) || !c.maxSessions || ctx.activeSessions(c.routeID) < c.maxSessions
  const fitsLimits = (c: RouteScore) => fits(c, ctx.estInputTokens) && withinSessions(c)
  const viable = sorted.filter((c) => c.health.selectable === true && fitsLimits(c))
  const probation = sorted.filter((c) => c.health.selectable === "probation" && fitsLimits(c))
  if (!viable.length) {
    // last resort before fallback: a route whose cooldown expired (a success there makes it healthy again)
    if (probation.length) return { routeID: probation[0]!.routeID, reason: "probation", top }
    // never leave the marker model in place: best route that is not permanently disabled, else anything
    const fb = sorted.find((c) => c.health.state !== "disabled") ?? sorted[0]
    if (!fb) throw new Error("no eligible routes")
    return { routeID: fb.routeID, reason: "fallback", top }
  }
  const best = viable[0]!
  const cur = state.routeID ? sorted.find((c) => c.routeID === state.routeID) : undefined
  if (cur) {
    const curViable = viable.includes(cur)
    if (!curViable)
      return { routeID: best.routeID, reason: cur.health.selectable !== true ? "failover" : !fits(cur, ctx.estInputTokens) ? "context" : "limit", top }
    if (best.routeID === cur.routeID || best.r - cur.r < ctx.switchMargin) return { routeID: cur.routeID, reason: "sticky", top }
    const since = state.betterSince ?? ctx.now
    if (ctx.now - since >= ctx.switchHoldMs) return { routeID: best.routeID, reason: "switch-better", top }
    return { routeID: cur.routeID, reason: "sticky-pending", betterSince: since, top }
  }
  // first turn: small exploration budget over routes with little live evidence that are not known to be weak
  if (ctx.rand() < ctx.explorationBudget) {
    const medianPEff = viable.map((c) => c.pEff).sort((a, b) => a - b)[Math.floor(viable.length / 2)] ?? 0
    // low-evidence routes that are not known to be weak, plus recovering routes (fresh evidence either way)
    const pool = [...viable.filter((c) => c.samples < 10 && c.pEff >= medianPEff), ...probation].filter((c) => c.routeID !== best.routeID)
    if (pool.length) return { routeID: pool[Math.floor(ctx.rand() * pool.length)]!.routeID, reason: "explore", top }
  }
  return { routeID: best.routeID, reason: "best", top }
}

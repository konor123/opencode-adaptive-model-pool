// chat.message selector (plan v1.3 §3.3): replaces an oamp/* marker with a real route for this turn.
// OpenCode then calls that route itself (Phase 0 E3), so OpenCode-only free models keep working.
import { log } from "../log.ts"
import type { OampOptions } from "../options.ts"
import { computeRouteScores, type RouteScore } from "../scoring/routes.ts"
import { type Db, kvGet } from "../storage/db.ts"
import { selectRoute } from "./select.ts"
import { activeSessionsOn, getSession, lastInputTokens, putSession, recordDecision, sha256, type StoredSession } from "./state.ts"

export const MARKER_PROVIDER = "oamp"
const SCORE_TTL_MS = 60_000

export interface SelectorDeps {
  db: Db
  opts: OampOptions
  /** resolves a session's parent id when the session.created event has not been seen yet */
  parentOf?: (sessionID: string) => Promise<string | undefined>
  now?: () => number
  rand?: () => number
}

export class Selector {
  private cache?: { at: number; scores: RouteScore[] }
  constructor(private d: SelectorDeps) {}

  private scores(now: number): RouteScore[] {
    const last = Number(JSON.parse(kvGet(this.d.db, "route-scores:last") ?? "{}").at ?? 0)
    if (!this.cache || now - this.cache.at > SCORE_TTL_MS || last > this.cache.at) {
      this.cache = { at: now, scores: computeRouteScores(this.d.db, this.d.opts, now) }
    }
    return this.cache.scores
  }

  /** Mark scores stale (e.g. after a failure was recorded) so the next turn sees it. */
  invalidate() {
    this.cache = undefined
  }

  /** session.created: child sessions of auto sessions inherit auto mode. */
  onSessionCreated(sessionID: string, parentID?: string) {
    if (!parentID || !this.d.opts.selector.inheritAutoToSubagents) return
    const parent = getSession(this.d.db, sha256(parentID))
    if (!parent?.auto) return
    const h = sha256(sessionID)
    if (getSession(this.d.db, h)) return
    putSession(this.d.db, { sessionHash: h, pool: parent.pool, auto: true, routeID: parent.routeID, turns: 0, parentHash: parent.sessionHash })
  }

  async onChatMessage(input: { sessionID: string; model?: { providerID: string; modelID: string } }, output: { message: any }): Promise<void> {
    const now = (this.d.now ?? Date.now)()
    const h = sha256(input.sessionID)
    let st = getSession(this.d.db, h)
    const marker = input.model?.providerID === MARKER_PROVIDER
    const inModel = input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined

    if (marker) {
      const pool = this.d.opts.pools[input.model!.modelID] ? input.model!.modelID : "auto"
      if (!st || st.pool !== pool || !st.auto) st = { sessionHash: h, pool, auto: true, routeID: st?.auto ? st.routeID : undefined, turns: st?.turns ?? 0 }
    } else {
      if (!st && this.d.parentOf && this.d.opts.selector.inheritAutoToSubagents) {
        // subagent whose session.created event we have not processed yet
        const parentID = await this.d.parentOf(input.sessionID).catch(() => undefined)
        if (parentID) {
          this.onSessionCreated(input.sessionID, parentID)
          st = getSession(this.d.db, h)
        }
      }
      if (!st?.auto) return
      if (st.routeID && inModel && inModel !== st.routeID) {
        // the user picked a different real model: manual selection wins from now on
        putSession(this.d.db, { ...st, auto: false }, now)
        log("info", "selector: manual model selected, auto off", { session: h.slice(0, 12), model: inModel })
        return
      }
    }

    const chosen = this.choose(st, now)
    if (!chosen) return
    output.message.model = { ...(output.message.model ?? {}), providerID: chosen.route.providerID, modelID: chosen.route.modelID }
  }

  /** Pick (and persist) the route for the next request of a session. */
  choose(st: StoredSession, now: number, reasonOverride?: string): { route: RouteScore; reason: string } | undefined {
    const pool = st.pool
    const h = st.sessionHash
    const cands = this.scores(now).filter((s) => s.pool === pool)
    if (!cands.length) {
      log("warn", "selector: no candidates; leaving model unchanged", { pool })
      return undefined
    }
    const decision = selectRoute(cands, { pool, routeID: st.routeID, betterSince: st.betterSince, turns: st.turns }, {
      now,
      estInputTokens: lastInputTokens(this.d.db, h),
      activeSessions: (r) => activeSessionsOn(this.d.db, r, h, now),
      switchMargin: this.d.opts.selector.switchMargin,
      switchHoldMs: this.d.opts.selector.switchHoldMinutes * 60_000,
      explorationBudget: st.turns === 0 && !st.parentHash && !reasonOverride ? this.d.opts.selector.explorationBudget : 0,
      rand: this.d.rand ?? Math.random,
    })
    const route = cands.find((c) => c.routeID === decision.routeID)!
    const reason = reasonOverride && decision.routeID !== st.routeID ? reasonOverride : decision.reason
    putSession(this.d.db, { ...st, routeID: route.routeID, betterSince: decision.betterSince, turns: st.turns + (reasonOverride ? 0 : 1) }, now)
    recordDecision(this.d.db, pool, h, route.routeID, decision.top, reason, now)
    log("info", "selector: route chosen", { session: h.slice(0, 12), pool, route: route.routeID, reason, top: decision.top })
    return { route, reason }
  }
}

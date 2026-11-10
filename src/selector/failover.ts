// In-turn failover (Phase 0 candidate E12, verified 2026-11-10 with `opencode serve`): when OpenCode starts retrying
// the same model in an auto session, abort the turn and continue it on the next healthy route.
// Safety: OAMP never replays a request itself. The failed step produced no output (OpenCode was retrying it), tools
// already executed in earlier steps stay in the history, and the model continues from that history.
import { log } from "../log.ts"
import type { OampOptions } from "../options.ts"
import type { Db } from "../storage/db.ts"
import type { Selector } from "./hook.ts"
import { getSession, putSession, sha256 } from "./state.ts"

export const CONTINUE_TEXT = "[OAMP] The previous model route failed while retrying. Continue the task from where it stopped; do not repeat completed steps."

export interface FailoverClient {
  session: {
    abort(o: { path: { id: string } }): Promise<unknown>
    promptAsync(o: { path: { id: string }; body: any }): Promise<unknown>
  }
  tui?: { showToast?(o: { body: { message: string; variant?: string } }): Promise<unknown> }
}

interface TurnGuard {
  switches: number
  busy: boolean
  /** retry events until this time belong to the step we just aborted */
  quietUntil?: number
}

/** Retry events of the aborted step can arrive after the switch; ignore them for this long. */
export const QUIET_MS = 5_000

export class InTurnFailover {
  private guards = new Map<string, TurnGuard>()
  private agents = new Map<string, string>()
  private ourPrompts = new Set<string>()
  constructor(
    private d: { db: Db; opts: OampOptions; selector: Selector; client?: FailoverClient; now?: () => number; delayMs?: number },
  ) {}

  /** chat.message: a real user turn resets the per-turn switch budget; our own continue prompt does not. */
  noteTurn(sessionID: string, agent: string | undefined, parts: any[] | undefined) {
    if (agent) this.agents.set(sessionID, agent)
    const ours = this.ourPrompts.has(sessionID) || (parts ?? []).some((p) => p?.type === "text" && typeof p.text === "string" && p.text.startsWith("[OAMP]"))
    if (ours) {
      this.ourPrompts.delete(sessionID)
      return
    }
    this.guards.set(sessionID, { switches: 0, busy: false })
  }

  /** true while retry events for this session belong to a step OAMP just aborted */
  isQuiet(sessionID: string): boolean {
    const q = this.guards.get(sessionID)?.quietUntil
    return !!q && (this.d.now ?? Date.now)() < q
  }

  async onRetry(sessionID: string, routeID: string, errorClass: string, attempt: number): Promise<boolean> {
    const cfg = this.d.opts.selector
    if (!cfg.inTurnFailover || !this.d.client) return false
    const st = getSession(this.d.db, sha256(sessionID))
    // root auto sessions only: aborting a subagent would fail the parent's task tool call
    if (!st?.auto || st.parentHash || st.routeID !== routeID) return false
    const g = this.guards.get(sessionID) ?? { switches: 0, busy: false }
    this.guards.set(sessionID, g)
    if (g.busy) return false
    if (g.quietUntil && (this.d.now ?? Date.now)() < g.quietUntil) return false
    if (g.switches >= cfg.maxSwitchesPerTurn) {
      log("warn", "in-turn failover budget exhausted; letting OpenCode retry", { route: routeID, switches: g.switches })
      return false
    }
    g.busy = true
    try {
      const now = (this.d.now ?? Date.now)()
      this.d.selector.invalidate() // the failure was recorded just before this call
      const next = this.d.selector.choose(st, now, "in-turn-failover")
      if (!next || next.route.routeID === routeID) {
        if (next) putSession(this.d.db, { ...st }, now) // keep state as it was
        log("warn", "in-turn failover: no alternative route", { route: routeID })
        return false
      }
      await this.d.client.session.abort({ path: { id: sessionID } })
      await new Promise((r) => setTimeout(r, this.d.delayMs ?? 300))
      this.ourPrompts.add(sessionID)
      await this.d.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          model: { providerID: next.route.providerID, modelID: next.route.modelID },
          ...(this.agents.get(sessionID) ? { agent: this.agents.get(sessionID) } : {}),
          parts: [{ type: "text", text: CONTINUE_TEXT, synthetic: true }],
        },
      })
      g.switches++
      g.quietUntil = (this.d.now ?? Date.now)() + QUIET_MS
      log("warn", "in-turn failover", { from: routeID, to: next.route.routeID, errorClass, attempt, switches: g.switches })
      this.d.client.tui?.showToast?.({ body: { message: `OAMP: ${routeID} failed (${errorClass}); continuing on ${next.route.routeID}`, variant: "warning" } })?.catch?.(() => {})
      return true
    } catch (e: any) {
      log("error", "in-turn failover failed", { error: String(e?.message ?? e) })
      return false
    } finally {
      g.busy = false
    }
  }
}

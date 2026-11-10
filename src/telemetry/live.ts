// Live telemetry from OpenCode events (Phase 0 E9): request start = chat.headers time, TTFT/TTFA = first parts,
// E2E/tokens/errors = message.updated. Rows are upserted by hashed message id, merging with the opencode.db import.
import type { Db } from "../storage/db.ts"
import { sha256 } from "../selector/state.ts"
import { classifyError, inBucket } from "./usage-import.ts"

const AUX_AGENTS = new Set(["compaction", "summary", "title"])

interface Pending {
  start: number
  agent: string
}
interface StepState {
  sessionID: string
  start?: number
  agent?: string
  ttft?: number
  ttfa?: number
  done?: boolean
}

export class LiveTelemetry {
  private pending = new Map<string, Pending[]>() // sessionID → request starts not yet bound to an assistant message
  private steps = new Map<string, StepState>() // assistant messageID → timing
  private lastRoute = new Map<string, string>() // sessionID → route of the latest assistant step
  /** called after a failure was recorded so selection can react on the next turn */
  onFailure?: (routeID: string, errorClass: string) => void
  constructor(private db: Db, private now: () => number = Date.now) {}

  onHeaders(sessionID: string, agent: string) {
    if (agent === "title") return // title generation produces no session message
    const q = this.pending.get(sessionID) ?? []
    q.push({ start: this.now(), agent })
    this.pending.set(sessionID, q.slice(-4))
  }

  onEvent(event: any) {
    const t = event?.type
    const p = event?.properties ?? {}
    if (t === "message.updated") return this.onMessage(p.info ?? {})
    if (t === "message.part.updated") return this.onPart(p.part ?? {})
    if (t === "session.status" && p.status?.type === "retry") return this.onRetry(p.sessionID, p.status)
  }

  /** OpenCode retries the same model in-turn (Phase 0 E7); each retry is an availability failure of that route. */
  private onRetry(sessionID: string, status: { attempt?: number; message?: string }) {
    const route = this.lastRoute.get(sessionID)
    if (!route) return
    const msg = String(status.message ?? "")
    const cls = /rate.?limit|429|too many|quota/i.test(msg) ? "rate_limit" : /timeout|timed out/i.test(msg) ? "timeout" : "server"
    this.db
      .query(`INSERT INTO request_metrics (ts, route_id, session_hash, kind, outcome, error_class, attempt_no) VALUES (?, ?, ?, 'primary', 'error', ?, ?)`)
      .run(this.now(), route, sha256(sessionID), cls, status.attempt ?? null)
    this.onFailure?.(route, cls)
  }

  private bind(messageID: string, sessionID: string): StepState {
    let s = this.steps.get(messageID)
    if (!s) {
      s = { sessionID }
      this.steps.set(messageID, s)
      if (this.steps.size > 500) this.steps.delete(this.steps.keys().next().value!)
    }
    if (s.start === undefined) {
      const q = this.pending.get(sessionID)
      const next = q?.shift()
      if (next) { s.start = next.start; s.agent = next.agent }
    }
    return s
  }

  private onPart(part: any) {
    const s = this.steps.get(part.messageID)
    if (!s || s.done) return // only parts of known assistant messages
    const ts = this.now()
    if (s.start === undefined) this.bind(part.messageID, s.sessionID)
    if (s.ttft === undefined && ["reasoning", "text", "tool"].includes(part.type)) s.ttft = ts
    if (s.ttfa === undefined && ["text", "tool"].includes(part.type)) s.ttfa = ts
  }

  private onMessage(m: any) {
    if (m.role !== "assistant" || !m.id || !m.sessionID) return
    if (m.providerID && m.modelID) this.lastRoute.set(m.sessionID, `${m.providerID}/${m.modelID}`)
    const s = this.bind(m.id, m.sessionID)
    const completed = m.time?.completed
    if (!completed && !m.error) return
    if (s.done) return
    s.done = true
    const tokens = m.tokens ?? {}
    const out = (tokens.output ?? 0) + (tokens.reasoning ?? 0)
    const inTok = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
    const outcome = m.error?.name === "MessageAbortedError" ? "aborted" : m.error ? "error" : "ok"
    const start = s.start ?? m.time?.created
    const e2e = outcome === "ok" && start && completed ? completed - start : null
    const ttft = s.ttft && start ? s.ttft - start : null
    const ttfa = s.ttfa && start ? s.ttfa - start : null
    const tps = e2e && out > 20 && s.ttft && completed > s.ttft ? out / ((completed - s.ttft) / 1000) : null
    const kind = AUX_AGENTS.has(s.agent ?? m.agent ?? "") || m.summary ? "aux" : "primary"
    this.db
      .query(`INSERT INTO request_metrics (ts, route_id, session_hash, msg_hash, kind, in_tokens, in_bucket, ttft_ms, ttfa_ms, e2e_ms, out_tokens, tps, outcome, error_class, finish)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(msg_hash) DO UPDATE SET kind = excluded.kind, ttft_ms = excluded.ttft_ms, ttfa_ms = excluded.ttfa_ms,
                e2e_ms = excluded.e2e_ms, tps = COALESCE(excluded.tps, request_metrics.tps), outcome = excluded.outcome,
                error_class = excluded.error_class, in_tokens = excluded.in_tokens, in_bucket = excluded.in_bucket, out_tokens = excluded.out_tokens`)
      .run(start ?? this.now(), `${m.providerID}/${m.modelID}`, sha256(m.sessionID), sha256(m.id), kind, inTok, inBucket(inTok),
        ttft, ttfa, e2e, out, tps, outcome, classifyError(m.error) ?? null, typeof m.finish === "string" ? m.finish : null)
    if (outcome === "error") this.onFailure?.(`${m.providerID}/${m.modelID}`, classifyError(m.error) ?? "other")
  }
}

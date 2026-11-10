// Self-evaluation driver: pass rates become "selfeval" benchmark observations per canonical model.
import { storeObservations } from "../benchmarks/store.ts"
import { log } from "../log.ts"
import { type Db, kvGet, kvSet } from "../storage/db.ts"
import { runTask, type TaskRun } from "./runner.ts"
import { type SelfEvalTask, TASKS } from "./tasks.ts"

export interface SelfEvalReport {
  route: string
  canonical: string
  coding: number
  tools: number
  runs: { task: string; valid: boolean; pass: boolean; ms: number; timedOut: boolean; exitCode: number | null }[]
}

const dayKey = (now: number) => `selfeval:runs:${new Date(now).toISOString().slice(0, 10)}`

export async function selfEvaluate(
  db: Db,
  routeIDs: string[],
  o: { maxRunsPerDay?: number; tasks?: SelfEvalTask[]; run?: (route: string, t: SelfEvalTask) => Promise<TaskRun>; now?: () => number } = {},
): Promise<SelfEvalReport[]> {
  const tasks = o.tasks ?? TASKS
  const run = o.run ?? runTask
  const now = o.now ?? Date.now
  const cap = o.maxRunsPerDay ?? 80
  const reports: SelfEvalReport[] = []
  for (const routeID of routeIDs) {
    const r = db.query("SELECT canonical_id FROM routes WHERE route_id = ?").get(routeID) as { canonical_id: string } | null
    if (!r) continue
    const used = Number(kvGet(db, dayKey(now())) ?? 0)
    if (used + tasks.length > cap) {
      log("warn", "selfeval daily cap reached", { used, cap })
      break
    }
    const runs: SelfEvalReport["runs"] = []
    for (const t of tasks) {
      const res = await run(routeID, t)
      runs.push({ task: t.id, valid: res.valid, pass: res.pass, ms: res.ms, timedOut: res.timedOut, exitCode: res.exitCode })
      db.query(`INSERT INTO request_metrics (ts, route_id, kind, e2e_ms, outcome, error_class) VALUES (?, ?, 'selfeval', ?, ?, ?)`)
        .run(now(), routeID, res.ms, res.pass ? "ok" : "error", res.pass ? null : !res.valid ? "run_failed" : res.timedOut ? "timeout" : "task_failed")
    }
    kvSet(db, dayKey(now()), String(used + tasks.length))
    const rate = (kind: string) => {
      const ks = tasks.filter((t) => t.kind === kind).map((t) => t.id)
      const rs = runs.filter((x) => ks.includes(x.task) && x.valid)
      return rs.length ? (100 * rs.filter((x) => x.pass).length) / rs.length : NaN
    }
    const coding = rate("coding")
    const tools = rate("tools")
    const at = now()
    const obs = [
      ...(Number.isFinite(coding) ? [{ benchmark: "selfeval_coding", raw: coding }] : []),
      ...(Number.isFinite(tools) ? [{ benchmark: "selfeval_tools", raw: tools }] : []),
    ].map((x) => ({ source: "selfeval" as const, via: "oamp-selfeval", version: "v1", subject: r.canonical_id, evaluatedAt: at, citation: "OAMP self-evaluation via opencode run", ...x }))
    storeObservations(db, obs, at)
    reports.push({ route: routeID, canonical: r.canonical_id, coding, tools, runs })
  }
  return reports
}

// KPIs (plan v1.0 §13) and the benchmark-vs-real-usage correlation check (plan §12 Phase 5 "가중치 상관 분석").
import { loadObservations } from "../benchmarks/store.ts"
import type { OampOptions } from "../options.ts"
import { usageIndicators } from "../scoring/compute.ts"
import type { Db } from "../storage/db.ts"

export function spearman(xs: number[], ys: number[]): number | undefined {
  const n = xs.length
  if (n < 3 || ys.length !== n) return undefined
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
    const r = new Array<number>(n)
    for (let i = 0; i < n; ) {
      let j = i
      while (j + 1 < n && idx[j + 1]![0] === idx[i]![0]) j++
      for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1
      i = j + 1
    }
    return r
  }
  const rx = rank(xs)
  const ry = rank(ys)
  const mx = rx.reduce((a, b) => a + b, 0) / n
  const my = ry.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my)
    dx += (rx[i]! - mx) ** 2
    dy += (ry[i]! - my) ** 2
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : undefined
}

export function kpis(db: Db, sinceMs: number) {
  const q = <T>(sql: string, ...a: any[]) => db.query(sql).all(...a) as T[]
  const decisions = q<{ reason: string; n: number }>("SELECT reason, count(*) n FROM rank_history WHERE ts >= ? GROUP BY reason ORDER BY n DESC", sinceMs)
  const chosen = q<{ route: string; n: number }>("SELECT chosen_route route, count(*) n FROM rank_history WHERE ts >= ? GROUP BY chosen_route ORDER BY n DESC LIMIT 10", sinceMs)
  // steps of auto sessions that ran on a paid route (target 0, plan §13 "Unintended Paid Calls")
  const paid = q<{ n: number }>(`SELECT count(*) n FROM request_metrics m JOIN session_routes s ON s.session_hash = m.session_hash AND s.auto = 1
    JOIN routes r ON r.route_id = m.route_id WHERE r.price_state = 'paid' AND m.ts >= ?`, sinceMs)[0]!.n
  const autoSteps = q<{ n: number; ok: number; err: number; p50: number | null }>(`SELECT count(*) n, sum(m.outcome='ok') ok, sum(m.outcome='error') err, NULL p50
    FROM request_metrics m JOIN session_routes s ON s.session_hash = m.session_hash AND s.auto = 1 WHERE m.ts >= ? AND m.kind IN ('primary','aux')`, sinceMs)[0]!
  const sessions = q<{ n: number; manual: number }>("SELECT count(*) n, sum(auto = 0) manual FROM session_routes WHERE updated_at >= ?", sinceMs)[0]!
  return { decisions, chosen, unintendedPaidSteps: paid, autoSteps, sessions }
}

/** Do external benchmarks predict real-usage tool quality? (per canonical model with usage evidence) */
export function benchmarkVsUsage(db: Db, opts: OampOptions, now = Date.now()) {
  const usage = usageIndicators(db, now)
  const rows = db.query("SELECT canonical_id, detail_json FROM scores s JOIN routes r ON r.route_id = s.route_id WHERE s.pool = 'auto'").all() as { canonical_id: string; detail_json: string | null }[]
  const ext = new Map<string, number>()
  for (const r of rows) {
    const d = JSON.parse(r.detail_json ?? "{}")
    const ind = d.indicators ?? {}
    const external = Object.entries(ind).filter(([k]) => !k.startsWith("usage_")) as [string, { value: number }][]
    const coding = external.filter(([k]) => ["aa_coding", "swe_bench_pro"].includes(k))
    if (coding.length) ext.set(r.canonical_id, coding.reduce((a, [, v]) => a + v.value, 0) / coding.length)
  }
  const pairs: { canonical: string; externalCoding: number; usageTools?: number; usageEdit?: number }[] = []
  for (const [canon, u] of usage) {
    const e = ext.get(canon)
    if (e === undefined) continue
    pairs.push({ canonical: canon, externalCoding: e, usageTools: u.usage_tools?.value, usageEdit: u.usage_edit?.value })
  }
  const withTools = pairs.filter((p) => p.usageTools !== undefined)
  const withEdit = pairs.filter((p) => p.usageEdit !== undefined)
  return {
    pairs,
    rhoTools: spearman(withTools.map((p) => p.externalCoding), withTools.map((p) => p.usageTools!)) ?? null,
    rhoEdit: spearman(withEdit.map((p) => p.externalCoding), withEdit.map((p) => p.usageEdit!)) ?? null,
    note: "Spearman rank correlation between external coding evidence and real-usage tool quality; with n < 8 it is indicative only.",
    benchmarkRows: loadObservations(db).length,
    weights: opts.weights,
  }
}

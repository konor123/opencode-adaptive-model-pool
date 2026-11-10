import type { Db } from "../storage/db.ts"
import type { BenchObservation } from "./types.ts"

export function storeObservations(db: Db, obs: BenchObservation[], collectedAt = Date.now()): number {
  const q = db.query(`
    INSERT INTO benchmarks (source, benchmark, version, harness, subject, effort, raw, evaluated_at, collected_at, citation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, benchmark, version, harness, subject, effort) DO UPDATE SET
      raw = excluded.raw, evaluated_at = excluded.evaluated_at, collected_at = excluded.collected_at, citation = excluded.citation`)
  let n = 0
  db.transaction(() => {
    for (const o of obs) {
      // harness column carries the fetch path so the same AA number via two routes stays distinguishable
      q.run(o.source, o.benchmark, o.version, o.via, o.subject, o.effort ?? "", o.raw, o.evaluatedAt ?? null, collectedAt, o.citation ?? null)
      n++
    }
  })()
  return n
}

export interface StoredObservation extends BenchObservation {
  collectedAt: number
}

export function loadObservations(db: Db): StoredObservation[] {
  return (db.query("SELECT * FROM benchmarks").all() as any[]).map((r) => ({
    source: r.source, via: r.harness, benchmark: r.benchmark, version: r.version, subject: r.subject,
    effort: r.effort || undefined, raw: r.raw, evaluatedAt: r.evaluated_at ?? undefined, citation: r.citation ?? undefined,
    collectedAt: r.collected_at,
  }))
}

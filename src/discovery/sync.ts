// Upsert routes and apply the stale → retired lifecycle (plan v1.0 §10: one miss = stale, two = retired).
import type { Db } from "../storage/db.ts"
import type { Route } from "../types.ts"

export interface SyncReport {
  added: number
  updated: number
  stale: number
  retired: number
}

export function syncRoutes(db: Db, routes: Route[], coveredProviders: string[], now = Date.now()): SyncReport {
  const rep: SyncReport = { added: 0, updated: 0, stale: 0, retired: 0 }
  const seen = new Set(routes.map((r) => r.routeID))
  const exists = db.query("SELECT status FROM routes WHERE route_id = ?")
  const upsert = db.query(`
    INSERT INTO routes (route_id, provider_id, model_id, variant, canonical_id, match_conf, source, price_state, eligible, ineligible,
                        tools, reasoning, ctx_limit, out_limit, meta_json, status, miss_count, first_seen, last_seen, updated_at)
    VALUES ($id, $p, $m, '', $canon, $conf, $src, $price, $elig, $inel, $tools, $reas, $ctx, $out, $meta, 'active', 0, $now, $now, $now)
    ON CONFLICT(route_id) DO UPDATE SET
      canonical_id = excluded.canonical_id, match_conf = excluded.match_conf, source = excluded.source,
      price_state = excluded.price_state, eligible = excluded.eligible, ineligible = excluded.ineligible,
      tools = excluded.tools, reasoning = excluded.reasoning, ctx_limit = excluded.ctx_limit, out_limit = excluded.out_limit,
      meta_json = excluded.meta_json,
      status = CASE WHEN routes.status = 'disabled' THEN 'disabled' ELSE 'active' END,
      miss_count = 0, last_seen = excluded.last_seen, updated_at = excluded.updated_at`)
  const b = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0)
  const tx = db.transaction(() => {
    for (const r of routes) {
      const had = exists.get(r.routeID)
      const m = r.model
      upsert.run({
        $id: r.routeID, $p: m.providerID, $m: m.modelID, $canon: r.canonicalID, $conf: r.matchConf, $src: m.source,
        $price: r.priceState, $elig: r.eligible ? 1 : 0, $inel: r.ineligibleReasons.join(","),
        $tools: b(m.toolCall), $reas: b(m.reasoning), $ctx: m.contextLimit ?? null, $out: m.outputLimit ?? null,
        $meta: JSON.stringify({ name: m.name, family: m.family, cost: m.cost, accessTier: m.accessTier, status: m.status,
          in: m.inputModalities, outMod: m.outputModalities }),
        $now: now,
      })
      had ? rep.updated++ : rep.added++
    }
    if (coveredProviders.length) {
      const ph = coveredProviders.map(() => "?").join(",")
      const missing = db
        .query(`SELECT route_id, miss_count FROM routes WHERE provider_id IN (${ph}) AND status IN ('active','stale')`)
        .all(...coveredProviders) as { route_id: string; miss_count: number }[]
      const mark = db.query("UPDATE routes SET miss_count = ?, status = ?, updated_at = ? WHERE route_id = ?")
      for (const row of missing) {
        if (seen.has(row.route_id)) continue
        const miss = row.miss_count + 1
        const status = miss >= 2 ? "retired" : "stale"
        mark.run(miss, status, now, row.route_id)
        status === "retired" ? rep.retired++ : rep.stale++
      }
    }
  })
  tx.immediate()
  return rep
}

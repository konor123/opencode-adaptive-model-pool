import type { Db } from "../storage/db.ts"
import type { CatalogModel } from "../types.ts"

export function getProviderCache(db: Db, providerID: string): { models: CatalogModel[]; fetchedAt: number } | undefined {
  const row = db.query("SELECT models_json, fetched_at FROM provider_models WHERE provider_id = ?").get(providerID) as
    | { models_json: string; fetched_at: number }
    | null
  if (!row) return undefined
  try {
    return { models: JSON.parse(row.models_json), fetchedAt: row.fetched_at }
  } catch {
    return undefined
  }
}

export function setProviderCache(db: Db, providerID: string, models: CatalogModel[], now = Date.now()) {
  db.query(
    `INSERT INTO provider_models (provider_id, models_json, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET models_json = excluded.models_json, fetched_at = excluded.fetched_at`,
  ).run(providerID, JSON.stringify(models), now)
}

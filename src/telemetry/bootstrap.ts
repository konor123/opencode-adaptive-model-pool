// History bootstrap from OpenCode's own DB (plan v1.3 §2.4, §5.3 priors).
// Initial version by the OpenCode worker (Orca task_4e000ca055ac); reviewed and hardened by the coordinator.
// The OpenCode DB is opened read-only. Only hashed ids and numeric metrics are stored.
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

export interface BootstrapResult {
  scanned: number
  inserted: number
  skipped: number
}

interface MessageRow {
  id: string
  session_id: string
  time_created: number
  data: string
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex")

export function classifyError(err: { name?: string; data?: { statusCode?: number; message?: string } } | undefined): string | undefined {
  if (!err) return undefined
  if (err.name === "MessageAbortedError") return "aborted"
  const code = err.data?.statusCode
  if (typeof code === "number") {
    if (code === 429) return "rate_limit"
    if (code === 401) return "auth"
    if (code === 403) return "forbidden"
    if (code === 404) return "not_found"
    if (code === 400) return /context|too long|maximum.*tokens/i.test(err.data?.message ?? "") ? "context_overflow" : "bad_request"
    if (code >= 500 && code <= 599) return "server"
  }
  return "other"
}

export function inBucket(inTokens: number): string {
  if (inTokens < 2000) return "0-2k"
  if (inTokens < 16000) return "2-16k"
  if (inTokens < 64000) return "16-64k"
  return "64k+"
}

export function bootstrapFromOpencodeDb(oampDb: Database, opencodeDbPath: string, opts?: { sinceMs?: number }): BootstrapResult {
  const result: BootstrapResult = { scanned: 0, inserted: 0, skipped: 0 }
  if (!opencodeDbPath || !existsSync(opencodeDbPath)) return result

  const src = new Database(opencodeDbPath, { readonly: true })
  let rows: MessageRow[]
  try {
    rows = src
      .query(
        `SELECT id, session_id, time_created, data FROM message
         WHERE time_created >= ? AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END) = 'assistant'`,
      )
      .all(opts?.sinceMs ?? 0) as MessageRow[]
  } finally {
    src.close()
  }

  const insert = oampDb.query(
    `INSERT OR IGNORE INTO request_metrics
       (ts, route_id, session_hash, msg_hash, kind, in_tokens, in_bucket, ttft_ms, ttfa_ms, e2e_ms, out_tokens, tps, outcome, error_class, attempt_no)
     VALUES (?, ?, ?, ?, 'history', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
  )

  oampDb.transaction(() => {
    for (const row of rows) {
      result.scanned++
      let d: any
      try {
        d = JSON.parse(row.data)
      } catch {
        result.skipped++
        continue
      }
      if (!d?.providerID || !d?.modelID) {
        result.skipped++
        continue
      }
      const error = d.error
      const outcome = error?.name === "MessageAbortedError" ? "aborted" : error ? "error" : "ok"
      const created = d.time?.created
      const completed = d.time?.completed
      const e2e = outcome === "ok" && typeof created === "number" && typeof completed === "number" ? completed - created : null
      const out = (d.tokens?.output ?? 0) + (d.tokens?.reasoning ?? 0)
      const inTok = (d.tokens?.input ?? 0) + (d.tokens?.cache?.read ?? 0) + (d.tokens?.cache?.write ?? 0)
      const tps = e2e && e2e > 0 && out > 20 ? out / (e2e / 1000) : null
      const res = insert.run(
        created ?? row.time_created,
        `${d.providerID}/${d.modelID}`,
        sha256(row.session_id),
        sha256(row.id),
        inTok,
        inBucket(inTok),
        e2e,
        out,
        tps,
        outcome,
        classifyError(error) ?? null,
      )
      result.inserted += res.changes
    }
  })()
  return result
}

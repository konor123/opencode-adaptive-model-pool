// Real-usage import from OpenCode's own DB (plan v1.3 §2.4, §5.1 usage indicators).
// Incremental and idempotent: every assistant step becomes one request_metrics row (kind 'history'), upserted by
// hashed message id so steps that were still running at the last import get completed later.
// The OpenCode DB is opened read-only. Only hashed ids, numbers and error classes are stored.
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

export interface ImportResult {
  scanned: number
  inserted: number
  updated: number
  skipped: number
  cursor: number
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

export const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch"])

/**
 * Model-attributable tool failures:
 *  - "schema": the model produced arguments that do not match the tool schema
 *  - "edit_mismatch": an edit whose oldString/patch context does not exist in the file
 * Everything else (file not found, command failed, tool limits) is "other" and not held against the model.
 */
export function classifyToolError(tool: string, error: string): "schema" | "edit_mismatch" | "other" {
  if (/called with invalid arguments|SchemaError|invalid_type|Expected .* received/i.test(error)) return "schema"
  if (EDIT_TOOLS.has(tool) && /Could not find oldString|oldString not found|patch.*(did not apply|failed to apply)|context not found/i.test(error)) return "edit_mismatch"
  return "other"
}

export function inBucket(inTokens: number): string {
  if (inTokens < 2000) return "0-2k"
  if (inTokens < 16000) return "2-16k"
  if (inTokens < 64000) return "16-64k"
  return "64k+"
}

/** Steps that may still be running are re-read: the next import starts this far before the newest seen step. */
export const OVERLAP_MS = 3 * 3_600_000

export function importUsage(oampDb: Database, opencodeDbPath: string, opts: { sinceMs?: number } = {}): ImportResult {
  const since = opts.sinceMs ?? 0
  const result: ImportResult = { scanned: 0, inserted: 0, updated: 0, skipped: 0, cursor: since }
  if (!opencodeDbPath || !existsSync(opencodeDbPath)) return result

  const src = new Database(opencodeDbPath, { readonly: true })
  let rows: { id: string; session_id: string; time_created: number; data: string }[]
  const tools = new Map<string, { calls: number; schema: number; other: number; edit: number; editFail: number }>()
  try {
    rows = src
      .query(
        `SELECT id, session_id, time_created, data FROM message
         WHERE time_created >= ? AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END) = 'assistant'`,
      )
      .all(since) as typeof rows
    const parts = src
      .query(
        `SELECT p.message_id AS mid, json_extract(p.data, '$.tool') AS tool, json_extract(p.data, '$.state.status') AS status,
                json_extract(p.data, '$.state.error') AS error
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE m.time_created >= ? AND json_valid(p.data) AND json_extract(p.data, '$.type') = 'tool'`,
      )
      .all(since) as { mid: string; tool: string | null; status: string | null; error: string | null }[]
    for (const p of parts) {
      if (p.status !== "completed" && p.status !== "error") continue // pending/running tools are not judged yet
      const t = tools.get(p.mid) ?? { calls: 0, schema: 0, other: 0, edit: 0, editFail: 0 }
      const tool = p.tool ?? ""
      t.calls++
      const isEdit = EDIT_TOOLS.has(tool)
      if (isEdit) t.edit++
      if (p.status === "error") {
        const cls = classifyToolError(tool, String(p.error ?? ""))
        if (cls === "schema") t.schema++
        else if (cls === "other") t.other++
        if (isEdit && cls !== "other") t.editFail++
      }
      tools.set(p.mid, t)
    }
  } finally {
    src.close()
  }

  const exists = oampDb.query("SELECT 1 FROM request_metrics WHERE msg_hash = ?")
  const upsert = oampDb.query(
    `INSERT INTO request_metrics
       (ts, route_id, session_hash, msg_hash, kind, in_tokens, in_bucket, e2e_ms, out_tokens, tps, outcome, error_class,
        finish, tool_calls, tool_schema_err, tool_other_err, edit_calls, edit_fail)
     VALUES (?, ?, ?, ?, 'history', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(msg_hash) DO UPDATE SET
       ts = excluded.ts, in_tokens = excluded.in_tokens, in_bucket = excluded.in_bucket, e2e_ms = excluded.e2e_ms,
       out_tokens = excluded.out_tokens, tps = excluded.tps, outcome = excluded.outcome, error_class = excluded.error_class,
       finish = excluded.finish, tool_calls = excluded.tool_calls, tool_schema_err = excluded.tool_schema_err,
       tool_other_err = excluded.tool_other_err, edit_calls = excluded.edit_calls, edit_fail = excluded.edit_fail`,
  )

  oampDb.transaction(() => {
    for (const row of rows) {
      result.scanned++
      result.cursor = Math.max(result.cursor, row.time_created)
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
      const t = tools.get(row.id) ?? { calls: 0, schema: 0, other: 0, edit: 0, editFail: 0 }
      const msgHash = sha256(row.id)
      const had = exists.get(msgHash)
      upsert.run(
        created ?? row.time_created, `${d.providerID}/${d.modelID}`, sha256(row.session_id), msgHash,
        inTok, inBucket(inTok), e2e, out, tps, outcome, classifyError(error) ?? null,
        typeof d.finish === "string" ? d.finish : null, t.calls, t.schema, t.other, t.edit, t.editFail,
      )
      had ? result.updated++ : result.inserted++
    }
  })()
  return result
}

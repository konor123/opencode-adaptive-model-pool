import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveOptions } from "../src/options.ts"
import { computePerformanceScores, usageIndicators } from "../src/scoring/compute.ts"
import { openDb } from "../src/storage/db.ts"
import { classifyError, classifyToolError, importUsage } from "../src/telemetry/usage-import.ts"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "oamp-usage-"))
  const p = join(dir, "opencode.db")
  const db = new Database(p, { create: true })
  db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
           CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`)
  const msg = db.prepare("INSERT INTO message VALUES (?,?,?,?)")
  const part = db.prepare("INSERT INTO part VALUES (?,?,?,?,?)")
  return { dir, p, db, msg, part }
}
const asst = (extra: object) => JSON.stringify({ role: "assistant", providerID: "p", modelID: "m", tokens: { input: 1000, output: 40 }, ...extra })
const tool = (tool: string, status: string, error?: string) => JSON.stringify({ type: "tool", tool, state: { status, error } })

test("classifiers", () => {
  expect(classifyError(undefined)).toBeUndefined()
  expect(classifyError({ name: "MessageAbortedError" })).toBe("aborted")
  expect(classifyError({ name: "APIError", data: { statusCode: 429 } })).toBe("rate_limit")
  expect(classifyError({ name: "APIError", data: { statusCode: 400, message: "context length exceeded" } })).toBe("context_overflow")
  expect(classifyError({ name: "APIError", data: { statusCode: 502 } })).toBe("server")
  expect(classifyError({ name: "Weird" })).toBe("other")
  expect(classifyToolError("read", 'The read tool was called with invalid arguments: SchemaError(Missing key at ["filePath"])')).toBe("schema")
  expect(classifyToolError("edit", "Could not find oldString in the file. It must match exactly")).toBe("edit_mismatch")
  expect(classifyToolError("read", "Could not find oldString")).toBe("other") // not an edit tool
  expect(classifyToolError("read", "File not found: /x")).toBe("other")
  expect(classifyToolError("grep", "Ripgrep JSON record exceeded 65536 bytes")).toBe("other")
})

test("import: steps + tool signals, read-only, idempotent, running steps get completed later", () => {
  const f = fixture()
  f.msg.run("m1", "s1", 100, asst({ time: { created: 100, completed: 1100 }, finish: "tool-calls" }))
  f.msg.run("m2", "s1", 200, asst({ time: { created: 200 } })) // still running
  f.msg.run("m3", "s1", 300, '{"role":"assistant", broken')
  f.msg.run("u1", "s1", 50, JSON.stringify({ role: "user" }))
  f.part.run("p1", "m1", "s1", 101, tool("read", "completed"))
  f.part.run("p2", "m1", "s1", 102, tool("read", "error", "The read tool was called with invalid arguments: SchemaError"))
  f.part.run("p3", "m1", "s1", 103, tool("edit", "error", "Could not find oldString in the file"))
  f.part.run("p4", "m1", "s1", 104, tool("edit", "completed"))
  f.part.run("p5", "m1", "s1", 105, tool("bash", "error", "command failed"))
  f.part.run("p6", "m2", "s1", 201, tool("read", "running"))
  f.part.run("p7", "m1", "s1", 106, JSON.stringify({ type: "text", text: "hello" }))
  const db = openDb(":memory:")
  const r1 = importUsage(db, f.p)
  // malformed m3 is filtered by json_valid in SQL (never scanned, never throws)
  expect(r1).toMatchObject({ scanned: 2, inserted: 2, updated: 0, skipped: 0, cursor: 200 })
  const m1 = db.query("SELECT * FROM request_metrics WHERE e2e_ms IS NOT NULL").get() as any
  expect(m1).toMatchObject({ route_id: "p/m", kind: "history", e2e_ms: 1000, finish: "tool-calls", tool_calls: 5, tool_schema_err: 1, tool_other_err: 1, edit_calls: 2, edit_fail: 1, in_bucket: "0-2k", outcome: "ok" })
  // raw ids never stored
  expect(JSON.stringify(db.query("SELECT * FROM request_metrics").all())).not.toMatch(/"(m1|m2|s1)"/)
  // m2 completes later; overlap re-import updates instead of duplicating
  f.db.query("UPDATE message SET data = ? WHERE id = 'm2'").run(asst({ time: { created: 200, completed: 700 }, finish: "stop" }))
  f.db.query("UPDATE part SET data = ? WHERE id = 'p6'").run(tool("read", "completed"))
  const r2 = importUsage(db, f.p, { sinceMs: 150 })
  expect(r2).toMatchObject({ inserted: 0, updated: 1 })
  expect((db.query("SELECT count(*) n FROM request_metrics").get() as any).n).toBe(2)
  expect((db.query("SELECT e2e_ms, tool_calls FROM request_metrics WHERE finish = 'stop'").get() as any)).toEqual({ e2e_ms: 500, tool_calls: 1 })
})

test("import of a missing db is a no-op and creates nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "oamp-usage-"))
  expect(importUsage(openDb(":memory:"), join(dir, "nested/opencode.db")).scanned).toBe(0)
  expect(existsSync(join(dir, "nested"))).toBe(false)
})

test("usage indicators need enough samples and feed the performance score", () => {
  const db = openDb(":memory:")
  const now = Date.parse("2026-11-10T00:00:00Z")
  db.query(`INSERT INTO routes (route_id, provider_id, model_id, canonical_id, match_conf, source, price_state, eligible, status, first_seen, last_seen, updated_at)
            VALUES ('a/x', 'a', 'x', 'org/x', 1, 'config', 'free_declared', 1, 'active', 0, 0, 0),
                   ('b/x', 'b', 'x', 'org/x', 1, 'config', 'free_declared', 1, 'active', 0, 0, 0),
                   ('c/y', 'c', 'y', 'org/y', 1, 'config', 'free_declared', 1, 'active', 0, 0, 0)`).run()
  const ins = db.query(`INSERT INTO request_metrics (ts, route_id, kind, outcome, tool_calls, tool_schema_err, edit_calls, edit_fail) VALUES (?, ?, 'history', 'ok', ?, ?, ?, ?)`)
  // org/x: 40 tool calls over two routes (shared canonical), 2 schema errors (95%), 20 edits with 3 failures (85%)
  ins.run(now - 1000, "a/x", 20, 1, 10, 2)
  ins.run(now - 2000, "b/x", 20, 1, 10, 1)
  // org/y: too few samples
  ins.run(now - 1000, "c/y", 10, 5, 5, 5)
  // outside the 30-day window: ignored
  ins.run(now - 40 * 86_400_000, "c/y", 100, 0, 100, 0)
  const u = usageIndicators(db, now)
  expect([...u.keys()]).toEqual(["org/x"])
  expect(u.get("org/x")!.usage_tools!.value).toBeCloseTo(50) // 95% on a 90..100 range
  expect(u.get("org/x")!.usage_edit!.value).toBeCloseTo(50) // 85% on a 70..100 range
  const scored = computePerformanceScores(db, resolveOptions({ scoring: { prior: 50 } }), undefined, now)
  const x = scored.find((s) => s.routeID === "a/x")!.result
  expect(x.used.sort()).toEqual(["usage_edit", "usage_tools"])
  expect(x.c).toBeGreaterThan(0)
  expect(scored.find((s) => s.routeID === "c/y")!.result.used).toEqual([])
})

// test/bootstrap.test.ts
import { expect, test } from "bun:test"
import { openDb } from "../src/storage/db.ts"
import { bootstrapFromOpencodeDb, classifyError } from "../src/telemetry/bootstrap.ts"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"

function ensureDirExists(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

test("classifyError handles all error classes correctly", () => {
  expect(classifyError(undefined)).toBeUndefined()

  expect(classifyError({ name: "MessageAbortedError" })).toBe("aborted")

  expect(classifyError({
    name: "APIError",
    data: { statusCode: 429, message: "Too many requests" }
  })).toBe("rate_limit")

  expect(classifyError({
    name: "APIError",
    data: { statusCode: 401, message: "Unauthorized" }
  })).toBe("auth")

  expect(classifyError({
    name: "APIError",
    data: { statusCode: 403, message: "Forbidden" }
  })).toBe("forbidden")

  expect(classifyError({
    name: "APIError",
    data: { statusCode: 404, message: "Not found" }
  })).toBe("not_found")

  expect(classifyError({
    name: "APIError",
    data: { statusCode: 400, message: "context length exceeded" }
  })).toBe("context_overflow")

  expect(classifyError({
    name: "APIError",
    data: { statusCode: 400, message: "bad request" }
  })).toBe("bad_request")

  expect(classifyError({
    name: "APIError",
    data: { statusCode: 500, message: "Internal server error" }
  })).toBe("server")

  expect(classifyError({
    name: "APIError",
    data: { statusCode: 999, message: "Unknown" }
  })).toBe("other")

  expect(classifyError({
    name: "SomeOtherError"
  })).toBe("other")
})

test("bootstrapFromOpencodeDb handles empty/nonexistent file gracefully", async () => {
  const oampDb = openDb(":memory:")
  const result = bootstrapFromOpencodeDb(oampDb, "/nonexistent/path/opencode.db")
  expect(result).toEqual({ scanned: 0, inserted: 0, skipped: 0 })
})

test("bootstrapFromOpencodeDb processes assistant messages correctly", async () => {
  const tempDir = path.join(tmpdir(), "oamp-test", Math.random().toString(36).substring(2, 11))
  ensureDirExists(tempDir)
  try {
    const opencodeDbPath = path.join(tempDir, "opencode.db")
    const oampDb = openDb(":memory:")

    const sourceDb = new (await import("bun:sqlite")).Database(opencodeDbPath)

    sourceDb.exec(
      `CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      )`
    )

    const testData = [
      {
        id: "msg_ok",
        session_id: "sess_1",
        time_created: 1000,
        data: JSON.stringify({
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-3",
          tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 50, write: 0 } },
          time: { created: 1000, completed: 2000 },
          finish: "success",
          error: null
        })
      },
      {
        id: "msg_aborted",
        session_id: "sess_2",
        time_created: 2000,
        data: JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-4",
          tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2000, completed: 3000 },
          finish: "aborted",
          error: { name: "MessageAbortedError", data: {} }
        })
      },
      {
        id: "msg_rate_limit",
        session_id: "sess_3",
        time_created: 3000,
        data: JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-4",
          tokens: { input: 300, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 3000, completed: 4000 },
          finish: "error",
          error: { name: "APIError", data: { statusCode: 429, message: "Too many requests" } }
        })
      },
      {
        id: "msg_context_overflow",
        session_id: "sess_4",
        time_created: 4000,
        data: JSON.stringify({
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-4",
          tokens: { input: 300, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 4000, completed: 5000 },
          finish: "error",
          error: { name: "APIError", data: { statusCode: 400, message: "context length exceeded" } }
        })
      },
      {
        id: "msg_user_role",
        session_id: "sess_5",
        time_created: 5000,
        data: JSON.stringify({
          role: "user",
          providerID: "anthropic",
          modelID: "claude-3",
          tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 5000, completed: 5000 },
          finish: "success",
          error: null
        })
      },
      {
        id: "msg_missing_provider",
        session_id: "sess_6",
        time_created: 6000,
        data: JSON.stringify({
          role: "assistant",
          modelID: "claude-3",
          tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 50, write: 0 } },
          time: { created: 6000, completed: 7000 },
          finish: "success",
          error: null
        })
      }
    ]

    for (const row of testData) {
      sourceDb.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
        row.id, row.session_id, row.time_created, row.data
      )
    }

    sourceDb.close()

    const result1 = bootstrapFromOpencodeDb(oampDb, opencodeDbPath)

    expect(result1.scanned).toBe(5)
    expect(result1.inserted).toBe(4)
    expect(result1.skipped).toBe(1)

    const metrics = oampDb.query("SELECT COUNT(*) as count FROM request_metrics WHERE kind = 'history'").get() as { count: number }
    expect(metrics.count).toBe(4)

    const firstMsg = oampDb.query("SELECT * FROM request_metrics WHERE msg_hash = (SELECT msg_hash FROM request_metrics WHERE route_id = 'anthropic/claude-3') LIMIT 1").get() as any
    expect(firstMsg.in_tokens).toBe(150)
    expect(firstMsg.out_tokens).toBe(60)
    expect(firstMsg.in_bucket).toBe("0-2k")
    expect(firstMsg.e2e_ms).toBe(1000)
    expect(firstMsg.tps).toBeCloseTo(60, 2)
    expect(firstMsg.outcome).toBe("ok")
    expect(firstMsg.error_class).toBeNull()

    const abortedMsg = oampDb.query("SELECT * FROM request_metrics WHERE route_id = 'openai/gpt-4' AND outcome = 'aborted' LIMIT 1").get() as any
    expect(abortedMsg.error_class).toBe("aborted")

    const rateLimitMsg = oampDb.query("SELECT * FROM request_metrics WHERE route_id = 'openai/gpt-4' AND outcome = 'error' AND error_class = 'rate_limit' LIMIT 1").get() as any
    expect(rateLimitMsg.error_class).toBe("rate_limit")

    const contextOverflowMsg = oampDb.query("SELECT * FROM request_metrics WHERE route_id = 'openai/gpt-4' AND outcome = 'error' AND error_class = 'context_overflow' LIMIT 1").get() as any
    expect(contextOverflowMsg.error_class).toBe("context_overflow")

    const skippedMsgCount = oampDb.query("SELECT COUNT(*) as count FROM request_metrics WHERE route_id IS NULL").get() as { count: number }
    expect(skippedMsgCount.count).toBe(0)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
test("missing opencode db is a no-op and creates nothing", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "oamp-boot-"))
  const missing = path.join(dir, "nested", "opencode.db")
  expect(bootstrapFromOpencodeDb(openDb(":memory:"), missing)).toEqual({ scanned: 0, inserted: 0, skipped: 0 })
  expect(fs.existsSync(path.join(dir, "nested"))).toBe(false)
})

test("corrupt rows are skipped, sinceMs filters in SQL", () => {
  const { Database } = require("bun:sqlite")
  const dir = fs.mkdtempSync(path.join(tmpdir(), "oamp-boot-"))
  const p = path.join(dir, "opencode.db")
  const src = new Database(p, { create: true })
  src.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)")
  const ins = src.prepare("INSERT INTO message VALUES (?,?,?,?)")
  ins.run("m1", "s1", 100, JSON.stringify({ role: "assistant", providerID: "p", modelID: "a", time: { created: 100, completed: 1100 }, tokens: { output: 50 } }))
  ins.run("m2", "s1", 200, '{"role":"assistant", broken')
  ins.run("m3", "s1", 300, JSON.stringify({ role: "assistant", providerID: "p", modelID: "b", time: { created: 300 } }))
  src.close()
  const db = openDb(":memory:")
  // malformed m2 must not abort the run
  const r = bootstrapFromOpencodeDb(db, p, { sinceMs: 150 })
  expect(r.inserted).toBe(1) // only m3 (m1 is older than sinceMs)
  const row = db.query("SELECT route_id, e2e_ms, outcome FROM request_metrics").get() as any
  expect(row).toEqual({ route_id: "p/b", e2e_ms: null, outcome: "ok" })
})

import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selfEvaluate } from "../src/selfeval/evaluate.ts"
import { TASKS } from "../src/selfeval/tasks.ts"
import { openDb } from "../src/storage/db.ts"

test("verifiers reject the untouched sandbox and accept a correct solution", () => {
  const solutions: Record<string, Record<string, string>> = {
    "fix-bug-py": { "calc.py": "def average(values):\n    return sum(values) / len(values)\n" },
    "rename-multi-file": {
      "util.py": 'def sum_items(items):\n    return sum(i["price"] * i["qty"] for i in items)\n',
      "main.py": "from util import sum_items\n\ndef run():\n    return sum_items([{\"price\": 3, \"qty\": 2}, {\"price\": 5, \"qty\": 1}])\n",
    },
    "write-json-exact": { "result.json": '{"name": "oamp", "version": 3, "tags": ["a", "b"]}' },
    "read-then-write": { "count.txt": "7\n" },
  }
  for (const t of TASKS) {
    const d = mkdtempSync(join(tmpdir(), "oamp-v-"))
    for (const [f, c] of Object.entries(t.files)) writeFileSync(join(d, f), c)
    expect(t.verify(d)).toBe(false)
    for (const [f, c] of Object.entries(solutions[t.id]!)) writeFileSync(join(d, f), c)
    expect(t.verify(d)).toBe(true)
  }
})

test("tampering with the test file fails verification", () => {
  const t = TASKS.find((x) => x.id === "fix-bug-py")!
  const d = mkdtempSync(join(tmpdir(), "oamp-v-"))
  for (const [f, c] of Object.entries(t.files)) writeFileSync(join(d, f), c)
  writeFileSync(join(d, "test_calc.py"), 'print("ok")\n')
  expect(t.verify(d)).toBe(false)
})

test("selfEvaluate stores pass rates per canonical id and respects the daily cap", async () => {
  const db = openDb(":memory:")
  db.query(`INSERT INTO routes (route_id, provider_id, model_id, canonical_id, match_conf, source, price_state, eligible, status, first_seen, last_seen, updated_at)
            VALUES ('p/m', 'p', 'm', 'org/m', 1, 'config', 'free_declared', 1, 'active', 0, 0, 0)`).run()
  const fake = async (_r: string, t: { kind: string; id: string }) => ({ valid: true, pass: t.id !== "rename-multi-file", ms: 10, exitCode: 0, timedOut: false })
  const reps = await selfEvaluate(db, ["p/m", "unknown/route"], { run: fake as any, now: () => Date.parse("2026-11-10T00:00:00Z") })
  expect(reps).toHaveLength(1)
  expect(reps[0]).toMatchObject({ canonical: "org/m", coding: 50, tools: 100 })
  const obs = db.query("SELECT benchmark, raw, subject, source FROM benchmarks ORDER BY benchmark").all()
  expect(obs).toEqual([
    { benchmark: "selfeval_coding", raw: 50, subject: "org/m", source: "selfeval" },
    { benchmark: "selfeval_tools", raw: 100, subject: "org/m", source: "selfeval" },
  ])
  expect((db.query("SELECT count(*) n FROM request_metrics WHERE kind='selfeval'").get() as any).n).toBe(4)
  const capped = await selfEvaluate(db, ["p/m"], { run: fake as any, maxRunsPerDay: 6, now: () => Date.parse("2026-11-10T01:00:00Z") })
  expect(capped).toHaveLength(0)
})

test("runs where OpenCode itself failed are not scored", async () => {
  const db = openDb(":memory:")
  db.query(`INSERT INTO routes (route_id, provider_id, model_id, canonical_id, match_conf, source, price_state, eligible, status, first_seen, last_seen, updated_at)
            VALUES ('p/m', 'p', 'm', 'org/m', 1, 'config', 'free_declared', 1, 'active', 0, 0, 0)`).run()
  const broken = async () => ({ valid: false, pass: false, ms: 5, exitCode: 1, timedOut: false })
  const reps = await selfEvaluate(db, ["p/m"], { run: broken as any })
  expect(Number.isNaN(reps[0]!.coding)).toBe(true)
  expect((db.query("SELECT count(*) n FROM benchmarks").get() as any).n).toBe(0)
})

test("child env drops BUN_BE_BUN", () => {
  process.env.BUN_BE_BUN = "1"
  const { childEnv } = require("../src/selfeval/runner.ts")
  expect(childEnv().BUN_BE_BUN).toBeUndefined()
  expect(childEnv().OAMP_SELFEVAL).toBe("1")
})

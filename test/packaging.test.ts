import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editConfigFile, transformConfig } from "../src/install/config-edit.ts"
import { migrate, MIGRATIONS, schemaVersion } from "../src/storage/db.ts"

const SPEC = "file:///repo/src/index.ts"
const canon = (o: object) => JSON.stringify(o, null, 2) + "\n"

test("install then uninstall restores the config byte-for-byte; other keys untouched", () => {
  const original = canon({ $schema: "x", model: "a/b", plugin: [["file:///other.ts", { x: 1 }]], provider: { p: { options: { apiKey: "{file:/k}" } } } })
  const inst = transformConfig(original, "install", SPEC).text!
  const parsed = JSON.parse(inst)
  expect(parsed.plugin).toEqual([["file:///other.ts", { x: 1 }], [SPEC, { enabled: true }]])
  expect({ ...parsed, plugin: undefined }).toEqual({ ...JSON.parse(original), plugin: undefined })
  expect(transformConfig(inst, "install", SPEC).reason).toBe("already-installed")
  expect(transformConfig(inst, "uninstall", SPEC).text).toBe(original)
  // a config without any plugin key gets it removed again on uninstall
  const bare = canon({ model: "a/b" })
  expect(transformConfig(transformConfig(bare, "install", SPEC).text!, "uninstall", SPEC).text).toBe(bare)
})

test("files that are not canonical JSON (comments, other formatting) are never rewritten", () => {
  expect(transformConfig('{\n  // comment\n  "model": "a/b"\n}\n', "install", SPEC).reason).toBe("not-canonical-json")
  expect(transformConfig('{"model":"a/b"}', "install", SPEC).reason).toBe("not-canonical-json")
  expect(transformConfig(canon({}), "uninstall", SPEC).reason).toBe("not-installed")
})

test("editConfigFile writes atomically with a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "oamp-cfg-"))
  const p = join(dir, "opencode.jsonc")
  const original = canon({ model: "a/b" })
  writeFileSync(p, original)
  const r = editConfigFile(p, "install", SPEC, 1)
  expect(r.changed).toBe(true)
  if (r.changed) expect(readFileSync(r.backup, "utf8")).toBe(original)
  expect(editConfigFile(p, "uninstall", SPEC, 2).changed).toBe(true)
  expect(readFileSync(p, "utf8")).toBe(original)
  expect(editConfigFile(join(dir, "missing.json"), "install", SPEC)).toEqual({ changed: false, reason: "missing-config" })
})

test("schema upgrade from v1 keeps data; older code on a newer schema is a no-op", () => {
  const db = new Database(":memory:")
  migrate(db, MIGRATIONS.slice(0, 1))
  expect(schemaVersion(db)).toBe(1)
  db.query("INSERT INTO kv (key, value, updated_at) VALUES ('k', 'v', 1)").run()
  migrate(db)
  expect(schemaVersion(db)).toBe(MIGRATIONS.length)
  expect((db.query("SELECT value FROM kv WHERE key='k'").get() as any).value).toBe("v")
  // rollback: code that knows fewer migrations opens the newer DB
  migrate(db, MIGRATIONS.slice(0, 2))
  expect(schemaVersion(db)).toBe(MIGRATIONS.length)
  db.query("INSERT INTO session_routes (session_hash, pool, created_at, updated_at) VALUES ('s','auto',1,1)").run()
})

test("spearman rank correlation", () => {
  const { spearman } = require("../src/cli/analysis.ts")
  expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1)
  expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1)
  expect(spearman([1, 2], [1, 2])).toBeUndefined()
  expect(spearman([1, 1, 1], [1, 2, 3])).toBeUndefined()
})

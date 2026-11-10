import { expect, test } from "bun:test"
import { acquireLease, kvGet, kvSet, openDb, releaseLease, schemaVersion } from "../src/storage/db.ts"

test("migrates to latest and is idempotent", () => {
  const db = openDb(":memory:")
  expect(schemaVersion(db)).toBe(3)
  // second migrate is a no-op
  const { migrate } = require("../src/storage/db.ts")
  migrate(db)
  expect(schemaVersion(db)).toBe(3)
})

test("lease excludes other holders until expiry", () => {
  const db = openDb(":memory:")
  expect(acquireLease(db, "job", "a", 1000, 0)).toBe(true)
  expect(acquireLease(db, "job", "b", 1000, 500)).toBe(false)
  expect(acquireLease(db, "job", "a", 1000, 600)).toBe(true) // renew by owner
  expect(acquireLease(db, "job", "b", 1000, 1601)).toBe(true) // expired
  releaseLease(db, "job", "b")
  expect(acquireLease(db, "job", "c", 1000, 1700)).toBe(true)
})

test("kv roundtrip", () => {
  const db = openDb(":memory:")
  expect(kvGet(db, "x")).toBeUndefined()
  kvSet(db, "x", "1")
  kvSet(db, "x", "2")
  expect(kvGet(db, "x")).toBe("2")
})

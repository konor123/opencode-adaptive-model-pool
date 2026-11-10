import { expect, test } from "bun:test"
import { loadSnapshots, snapshotObservations } from "../src/benchmarks/snapshots.ts"
import { storeObservations } from "../src/benchmarks/store.ts"
import { resolveOptions } from "../src/options.ts"
import { computePerformanceScores } from "../src/scoring/compute.ts"
import { openDb } from "../src/storage/db.ts"

test("bundled snapshots parse; only hand-mapped rows carry a canonical id", () => {
  const obs = loadSnapshots()
  const swe = obs.filter((o) => o.benchmark === "swe_bench_pro")
  const mcp = obs.filter((o) => o.benchmark === "mcp_atlas")
  expect(swe.length).toBe(18)
  expect(mcp.length).toBe(37)
  expect(obs.filter((o) => o.subject.startsWith("canon:")).map((o) => o.subject).sort()).toEqual([
    "canon:minimax/minimax-m3.1-flash",
    "canon:nvidia/nemotron-3-ultra-550b-a55b",
  ])
  expect(swe.every((o) => o.source === "snapshot" && o.version === "public-v2@2026-09-22" && o.evaluatedAt === Date.parse("2026-09-22"))).toBe(true)
})

test("snapshot rows feed the matching canonical route, normalized on the whole leaderboard", () => {
  const db = openDb(":memory:")
  db.query(`INSERT INTO routes (route_id, provider_id, model_id, canonical_id, match_conf, source, price_state, eligible, status, first_seen, last_seen, updated_at)
            VALUES ('nvidia/minimaxai/minimax-m3.1-flash','nvidia','minimaxai/minimax-m3.1-flash','minimax/minimax-m3.1-flash',1,'models.dev','free_quota',1,'active',0,0,0)`).run()
  const obs = snapshotObservations({ benchmark: "swe_bench_pro", version: "t", updated: "2026-09-22",
    rows: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((s, i) => ({ name: `m${i}`, score: s })).concat([{ name: "ours", score: 75 }]),
    map: { ours: "minimax/minimax-m3.1-flash" } })
  storeObservations(db, obs)
  const [r] = computePerformanceScores(db, resolveOptions({ scoring: { prior: 50 } }), undefined, Date.parse("2026-11-10"))
  expect(r!.result.used).toEqual(["swe_bench_pro"])
  const v = (JSON.parse((db.query("SELECT detail_json FROM scores").get() as any).detail_json).indicators.swe_bench_pro).value
  expect(v).toBeGreaterThan(60)
  expect(v).toBeLessThan(80)
})

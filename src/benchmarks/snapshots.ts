// Versioned leaderboard snapshots (data/snapshots/*.json) → benchmark observations (plan v1.0 §4.2).
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { BenchObservation } from "./types.ts"

export const SNAPSHOT_DIR = join(import.meta.dir, "../../data/snapshots")

export interface Snapshot {
  benchmark: string
  version: string
  updated?: string
  citation?: string
  rows: { name: string; score: number }[]
  map?: Record<string, string>
}

/** Mapped rows get subject "canon:<id>"; unmapped rows ("name:<leaderboard name>") only shape the reference range. */
export function snapshotObservations(s: Snapshot): BenchObservation[] {
  const at = s.updated && !Number.isNaN(Date.parse(s.updated)) ? Date.parse(s.updated) : undefined
  return s.rows
    .filter((r) => typeof r?.name === "string" && Number.isFinite(r?.score))
    .map((r) => ({
      source: "snapshot" as const,
      via: "snapshot-file",
      benchmark: s.benchmark,
      version: s.version,
      subject: s.map?.[r.name] ? `canon:${s.map[r.name]!.toLowerCase()}` : `name:${r.name}`,
      raw: r.score,
      evaluatedAt: at,
      citation: s.citation,
    }))
}

export function loadSnapshots(dir = SNAPSHOT_DIR): BenchObservation[] {
  if (!existsSync(dir)) return []
  const out: BenchObservation[] = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      out.push(...snapshotObservations(JSON.parse(readFileSync(join(dir, f), "utf8"))))
    } catch {}
  }
  return out
}

// Minimal file logger (never stderr: the TUI owns the terminal). Never pass secrets here.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

let logPath: string | undefined

export function initLog(dbPath: string) {
  logPath = dbPath === ":memory:" ? undefined : join(dirname(dbPath), "oamp.log")
  if (logPath) mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
}

export function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  if (!logPath) return
  try {
    try {
      if (statSync(logPath).size > 1_000_000) writeFileSync(logPath, "")
    } catch {}
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, level, msg, ...data }) + "\n")
  } catch {}
}

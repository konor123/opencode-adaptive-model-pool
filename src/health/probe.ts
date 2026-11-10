// Manual recovery probe (plan v1.3 §6.3): one tiny request through OpenCode itself (`opencode run`), so every provider
// is called its native way. Not scheduled automatically — recovery is normally confirmed by real traffic.
// The probe session is deleted afterwards; its telemetry is tagged kind 'probe' (OAMP_PROBE=1).
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? join(homedir(), ".opencode/bin/opencode")
export const PROBE_TEXT = "Reply with exactly: OK"

export interface ProbeResult {
  ok: boolean
  ms: number
  sessionID?: string
  error?: string
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OAMP_PROBE: "1" }
  delete env.BUN_BE_BUN // the CLI itself may run as `BUN_BE_BUN=1 opencode`
  return env
}

function run(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(OPENCODE_BIN, args, { stdio: ["ignore", "pipe", "ignore"], env: childEnv() })
    let stdout = ""
    let timedOut = false
    child.stdout.on("data", (b) => (stdout += b.toString()))
    const t = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(t)
      resolve({ code, stdout, timedOut })
    })
  })
}

export function parseRunEvents(stdout: string): { sessionID?: string; text: string; error?: string } {
  let sessionID: string | undefined
  let text = ""
  let error: string | undefined
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue
    try {
      const e = JSON.parse(line)
      sessionID ??= e.sessionID ?? e.part?.sessionID
      if (e.part?.type === "text" && typeof e.part.text === "string") text += e.part.text
      if (e.type === "error" || e.error) error = String(e.error?.data?.message ?? e.error?.name ?? e.error ?? "error")
    } catch {}
  }
  return { sessionID, text, error }
}

export async function probeRoute(routeID: string, timeoutMs = 90_000): Promise<ProbeResult> {
  const started = Date.now()
  const r = await run(["run", "--model", routeID, "--format", "json", "--title", "oamp-probe", PROBE_TEXT], timeoutMs)
  const ev = parseRunEvents(r.stdout)
  const ok = !r.timedOut && r.code === 0 && /\bOK\b/.test(ev.text)
  if (ev.sessionID) await run(["session", "delete", ev.sessionID], 30_000)
  return { ok, ms: Date.now() - started, sessionID: ev.sessionID, error: ok ? undefined : r.timedOut ? "timeout" : ev.error ?? `exit ${r.code}` }
}

// Runs one self-eval task through OpenCode itself (`opencode run`), so every provider is called its native way
// (required for OpenCode-only free models). Sandbox = fresh temp dir, removed afterwards.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { SelfEvalTask } from "./tasks.ts"

export interface TaskRun {
  /** false when OpenCode itself failed (non-zero exit: provider/API/infra error) → not a model result */
  valid: boolean
  pass: boolean
  ms: number
  exitCode: number | null
  timedOut: boolean
}

export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? join(homedir(), ".opencode/bin/opencode")

/** The CLI may itself run under `BUN_BE_BUN=1 opencode`; that flag must not reach the child or it starts Bun, not OpenCode. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OAMP_SELFEVAL: "1" }
  delete env.BUN_BE_BUN
  return env
}

export function runTask(routeID: string, task: SelfEvalTask, timeoutMs = 240_000): Promise<TaskRun> {
  const dir = mkdtempSync(join(tmpdir(), `oamp-selfeval-${task.id}-`))
  for (const [f, c] of Object.entries(task.files)) writeFileSync(join(dir, f), c)
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(OPENCODE_BIN, ["run", "--model", routeID, "--title", `oamp-selfeval ${task.id}`, "--dir", dir, task.prompt], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"], // stdin must not be a pipe: `opencode run` waits on it
      env: childEnv(),
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5000)
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      let pass = false
      try {
        pass = !timedOut && task.verify(dir)
      } catch {}
      rmSync(dir, { recursive: true, force: true })
      // timeouts count as a model failure (stuck or too slow); other non-zero exits are not scored
      const valid = timedOut || code === 0
      resolve({ valid, pass: valid && pass, ms: Date.now() - started, exitCode: code, timedOut })
    })
  })
}

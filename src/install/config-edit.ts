// Install / uninstall the plugin entry in OpenCode's config (plan v1.0 §1: installable and removable without
// changing anything else). Edits are structural only when the file round-trips byte-for-byte through
// JSON.parse/stringify(…, 2); otherwise the user gets the one line to add by hand instead.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export const PLUGIN_MARK = "opencode-adaptive-model-pool"
export const pluginSpec = (repoRoot: string) => `file://${resolve(repoRoot, "src/index.ts")}`

export type EditResult =
  | { changed: true; backup: string; text: string }
  | { changed: false; reason: "already-installed" | "not-installed" | "not-canonical-json" | "missing-config"; hint?: string }

/** The OAMP entry: exactly this checkout's spec, or any spec under a directory named like the project. */
const isOamp = (entry: unknown, spec: string) => {
  const s = Array.isArray(entry) ? String(entry[0]) : String(entry)
  return s === spec || s.includes(PLUGIN_MARK)
}

/** Pure text transform (tested): returns the new file text, or a reason why it will not touch the file. */
export function transformConfig(
  text: string,
  mode: "install" | "uninstall",
  spec: string,
  options: object = { enabled: true },
): { text?: string; reason?: "already-installed" | "not-installed" | "not-canonical-json" } {
  let cfg: any
  try {
    cfg = JSON.parse(text)
  } catch {
    return { reason: "not-canonical-json" }
  }
  if (JSON.stringify(cfg, null, 2) + "\n" !== text) return { reason: "not-canonical-json" }
  const plugins: unknown[] = Array.isArray(cfg.plugin) ? cfg.plugin : []
  const has = plugins.some((p) => isOamp(p, spec))
  if (mode === "install") {
    if (has) return { reason: "already-installed" }
    cfg.plugin = [...plugins, [spec, options]]
  } else {
    if (!has) return { reason: "not-installed" }
    const rest = plugins.filter((p) => !isOamp(p, spec))
    if (rest.length) cfg.plugin = rest
    else delete cfg.plugin
  }
  return { text: JSON.stringify(cfg, null, 2) + "\n" }
}

export function editConfigFile(path: string, mode: "install" | "uninstall", spec: string, now = Date.now()): EditResult {
  if (!existsSync(path)) return { changed: false, reason: "missing-config" }
  const original = readFileSync(path, "utf8")
  const r = transformConfig(original, mode, spec)
  if (!r.text) {
    return {
      changed: false,
      reason: r.reason ?? "not-canonical-json",
      hint: r.reason === "not-canonical-json" ? `edit ${path} by hand: add ["${spec}", {"enabled": true}] to "plugin"` : undefined,
    }
  }
  const backup = `${path}.bak-oamp-${new Date(now).toISOString().replace(/[:.]/g, "-")}`
  copyFileSync(path, backup)
  const tmp = join(dirname(path), `.oamp-${process.pid}-${now}.tmp`)
  writeFileSync(tmp, r.text, { mode: 0o600 })
  if (readFileSync(path, "utf8") !== original) throw new Error("config changed concurrently; nothing written")
  renameSync(tmp, path)
  return { changed: true, backup, text: r.text }
}

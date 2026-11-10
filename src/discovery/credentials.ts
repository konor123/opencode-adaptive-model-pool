// Resolve a provider API key for /v1/models fetches only. Values stay in memory; never logged or stored.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function resolveProviderKey(providerID: string, providerCfg: any, authPath: string): string | undefined {
  const raw = providerCfg?.options?.apiKey
  if (typeof raw === "string" && raw.trim()) {
    const file = raw.match(/^\{file:(.+)\}$/)
    if (file) {
      const p = file[1]!.startsWith("~/") ? join(homedir(), file[1]!.slice(2)) : file[1]!
      return existsSync(p) ? readFileSync(p, "utf8").trim() || undefined : undefined
    }
    const env = raw.match(/^\{env:(.+)\}$/)
    if (env) return process.env[env[1]!]?.trim() || undefined
    return raw.trim()
  }
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"))
    const k = auth?.[providerID]?.key
    return typeof k === "string" && k.trim() ? k.trim() : undefined
  } catch {
    return undefined
  }
}

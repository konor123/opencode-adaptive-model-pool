// Plugin options with defaults (plan v1.3 §10). Unknown keys are ignored.
import { homedir } from "node:os"
import { join } from "node:path"

export interface ProviderSyncSpec {
  /** "free-chat": keep only access_tier=free, pricing 0, modality chat (xkiro). */
  filter?: "free-chat" | "all"
}

export interface OampOptions {
  enabled: boolean
  providers: string[]
  policy: {
    allowPaid: boolean
    allowUnknownPrice: boolean
    freeDeclared: string[]
    deny: string[]
    requireToolCalling: boolean
    quotaProviders: string[]
  }
  providerSync: Record<string, ProviderSyncSpec>
  refresh: { providerModelsHours: number; catalogHours: number }
  storage: { path: string }
  paths: { modelsDevCache: string; opencodeDb: string; opencodeAuth: string }
}

const HOME = homedir()

export const DEFAULT_OPTIONS: OampOptions = {
  enabled: true,
  providers: ["opencode", "openrouter", "nvidia", "xkiro", "exaone"],
  policy: {
    allowPaid: false,
    allowUnknownPrice: false,
    freeDeclared: ["xkiro/*", "exaone/*"],
    deny: [],
    requireToolCalling: true,
    quotaProviders: ["nvidia"],
  },
  providerSync: { xkiro: { filter: "free-chat" }, exaone: { filter: "all" } },
  refresh: { providerModelsHours: 6, catalogHours: 6 },
  storage: { path: join(HOME, ".local/share/oamp/oamp.db") },
  paths: {
    modelsDevCache: join(HOME, ".cache/opencode/models.json"),
    opencodeDb: join(HOME, ".local/share/opencode/opencode.db"),
    opencodeAuth: join(HOME, ".local/share/opencode/auth.json"),
  },
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)

// Keys under these maps are user-defined (e.g. providerSync.<providerID>); elsewhere unknown keys are ignored.
const FREE_FORM = new Set(["providerSync"])

function merge<T>(base: T, over: unknown, freeForm = false): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T))
  const out: Record<string, any> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (!(k in out)) {
      if (freeForm) out[k] = v
      continue
    }
    out[k] = isObj(out[k]) && isObj(v) ? merge(out[k], v, FREE_FORM.has(k)) : v
  }
  return out as T
}

const expandHome = (p: string) => (p.startsWith("~/") ? join(HOME, p.slice(2)) : p)

export function resolveOptions(raw?: unknown): OampOptions {
  const o = merge(DEFAULT_OPTIONS, raw ?? {})
  o.storage.path = expandHome(o.storage.path)
  for (const k of Object.keys(o.paths) as (keyof OampOptions["paths"])[]) o.paths[k] = expandHome(o.paths[k])
  return o
}

/** Glob with "*" only, matched against "provider/model". */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$")
  return re.test(value)
}

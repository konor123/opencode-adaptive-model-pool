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
  weights: { performance: number; latency: number; coding: number; agentic: number; reasoning: number; availabilityPenalty: boolean }
  latency: { ttfa: number; e2e: number; tps: number; ewmaAlpha: number; priorWeight: number }
  pools: Record<string, { weights?: { performance?: number; latency?: number } }>
  selector: {
    switchMargin: number
    switchHoldMinutes: number
    explorationBudget: number
    inheritAutoToSubagents: boolean
    /** abort a retrying turn and continue on the next route (E12) */
    inTurnFailover: boolean
    maxSwitchesPerTurn: number
  }
  routeLimits: Record<string, { maxSessions?: number }>
  /** where P_eff shrinks to without evidence: "pool-median" (median P of evidenced eligible routes) or a fixed number */
  scoring: { prior: "pool-median" | number }
  benchmarks: { openrouter: { enabled: boolean }; artificialAnalysis: { enabled: boolean; keyFile: string } }
  refresh: { providerModelsHours: number; catalogHours: number; benchmarkHours: number }
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
  weights: { performance: 0.7, latency: 0.3, coding: 0.55, agentic: 0.3, reasoning: 0.15, availabilityPenalty: true },
  scoring: { prior: "pool-median" },
  latency: { ttfa: 0.35, e2e: 0.45, tps: 0.2, ewmaAlpha: 0.25, priorWeight: 10 },
  pools: { auto: {}, fast: { weights: { performance: 0.4, latency: 0.6 } } },
  selector: { switchMargin: 5, switchHoldMinutes: 30, explorationBudget: 0.05, inheritAutoToSubagents: true, inTurnFailover: true, maxSwitchesPerTurn: 2 },
  routeLimits: { "exaone/*": { maxSessions: 1 } },
  benchmarks: {
    openrouter: { enabled: true },
    artificialAnalysis: { enabled: true, keyFile: join(HOME, ".config/oamp/aa-api-key") },
  },
  refresh: { providerModelsHours: 6, catalogHours: 6, benchmarkHours: 24 },
  storage: { path: join(HOME, ".local/share/oamp/oamp.db") },
  paths: {
    modelsDevCache: join(HOME, ".cache/opencode/models.json"),
    opencodeDb: join(HOME, ".local/share/opencode/opencode.db"),
    opencodeAuth: join(HOME, ".local/share/opencode/auth.json"),
  },
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)

// Keys under these maps are user-defined (e.g. providerSync.<providerID>); elsewhere unknown keys are ignored.
const FREE_FORM = new Set(["providerSync", "pools", "routeLimits"])

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
  let o = merge(DEFAULT_OPTIONS, raw ?? {})
  // operational/test override, e.g. OAMP_OPTIONS='{"storage":{"path":"/tmp/x.db"}}'
  if (process.env.OAMP_OPTIONS) {
    try {
      o = merge(o, JSON.parse(process.env.OAMP_OPTIONS))
    } catch {}
  }
  o.storage.path = expandHome(o.storage.path)
  o.benchmarks.artificialAnalysis.keyFile = expandHome(o.benchmarks.artificialAnalysis.keyFile)
  for (const k of Object.keys(o.paths) as (keyof OampOptions["paths"])[]) o.paths[k] = expandHome(o.paths[k])
  return o
}

/** Glob with "*" only, matched against "provider/model". */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$")
  return re.test(value)
}

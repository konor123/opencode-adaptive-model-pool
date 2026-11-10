// Shared OAMP types. Pure data; no OpenCode or runtime dependencies.

export type PriceState = "free_verified" | "free_quota" | "free_declared" | "paid" | "unknown"
export type RouteStatus = "active" | "stale" | "retired" | "disabled"
export type CatalogSource = "models.dev" | "provider-api" | "config"

export interface Cost {
  input: number
  output: number
}

/** One model as exposed (or exposable) by an OpenCode provider. */
export interface CatalogModel {
  providerID: string
  modelID: string
  name?: string
  /** models.dev canonical_model_id when available. */
  canonicalID?: string
  family?: string
  /** undefined = no price information at all. */
  cost?: Cost
  toolCall?: boolean
  reasoning?: boolean
  contextLimit?: number
  outputLimit?: number
  inputModalities?: string[]
  outputModalities?: string[]
  /** models.dev status: alpha | beta | deprecated | active */
  status?: string
  /** provider API access tier (xkiro: free | paid | premium) */
  accessTier?: string
  source: CatalogSource
}

export interface Route {
  routeID: string // "provider/model" (variant suffix "#v" reserved)
  model: CatalogModel
  canonicalID: string
  matchConf: number
  priceState: PriceState
  eligible: boolean
  ineligibleReasons: string[]
}

export const routeIdOf = (providerID: string, modelID: string, variant?: string) =>
  `${providerID}/${modelID}${variant ? `#${variant}` : ""}`

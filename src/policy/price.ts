// Price state classification (plan v1.3 §7.1). An explicit paid signal always wins.
import { globMatch, type OampOptions } from "../options.ts"
import type { CatalogModel, PriceState } from "../types.ts"

const FREE_MARKER = /(:free|-free|\/free)$/i

export function priceStateOf(m: CatalogModel, policy: OampOptions["policy"]): PriceState {
  const route = `${m.providerID}/${m.modelID}`
  const declared = policy.freeDeclared.some((p) => globMatch(p, route))

  // 1. explicit paid signals
  if (m.accessTier && m.accessTier !== "free") return "paid"
  if (m.cost && (m.cost.input > 0 || m.cost.output > 0)) return "paid"

  // 2. provider API says free with zero price (xkiro)
  if (m.accessTier === "free" && m.cost && m.cost.input === 0 && m.cost.output === 0) return "free_verified"

  // 3. zero cost from the catalog
  if (m.cost && m.cost.input === 0 && m.cost.output === 0) {
    if (policy.quotaProviders.includes(m.providerID)) return "free_quota"
    if (FREE_MARKER.test(m.modelID)) return "free_verified"
    if (declared) return "free_declared"
    return "unknown"
  }

  // 4. no price information
  return declared ? "free_declared" : "unknown"
}

export function priceAllowed(state: PriceState, policy: OampOptions["policy"]): boolean {
  if (state === "paid") return policy.allowPaid
  if (state === "unknown") return policy.allowUnknownPrice
  return true
}

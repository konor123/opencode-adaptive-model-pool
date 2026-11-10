// Route construction + eligibility filters (plan v1.3 §5.6 step 1, §7).
import { canonicalOf } from "../identity/canonical.ts"
import { globMatch, type OampOptions } from "../options.ts"
import { type CatalogModel, type Route, routeIdOf } from "../types.ts"
import { priceAllowed, priceStateOf } from "./price.ts"

export function buildRoute(m: CatalogModel, opts: OampOptions): Route {
  const routeID = routeIdOf(m.providerID, m.modelID)
  const { canonicalID, matchConf } = canonicalOf(m)
  const priceState = priceStateOf(m, opts.policy)
  const reasons: string[] = []
  if (!priceAllowed(priceState, opts.policy)) reasons.push(`price:${priceState}`)
  if (opts.policy.requireToolCalling) {
    if (m.toolCall === false) reasons.push("no_tools")
    else if (m.toolCall === undefined) reasons.push("tools_unknown")
  }
  if (m.outputModalities && !m.outputModalities.includes("text")) reasons.push("no_text_output")
  if (m.status === "deprecated") reasons.push("deprecated")
  if (opts.policy.deny.some((p) => globMatch(p, routeID))) reasons.push("denied")
  return { routeID, model: m, canonicalID, matchConf, priceState, eligible: reasons.length === 0, ineligibleReasons: reasons }
}

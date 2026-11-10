// Phase 0 probe (V2 promise API): E1 load, E2 catalog read.
import { appendFileSync } from "node:fs"
const LOG = process.env.OAMP_POC_LOG ?? "/tmp/oamp-poc/log.jsonl"
const log = (rec: Record<string, unknown>) => { try { appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...rec }) + "\n") } catch {} }

export default {
  id: "oamp-phase0-v2",
  async setup(ctx: any) {
    log({ k: "v2.setup", ctxKeys: Object.keys(ctx ?? {}), options: ctx?.options })
    try {
      await ctx.catalog.transform((draft: any) => {
        const providers = draft.provider.list().map((r: any) => ({
          id: r.provider.id, api: r.provider.api?.type, pkg: r.provider.api?.package, n: r.models.size,
          sample: [...r.models.values()].slice(0, 2).map((m: any) => ({ id: m.id, enabled: m.enabled, status: m.status, tools: m.capabilities?.tools, cost: m.cost?.[0], ctx: m.limit?.context })),
        }))
        log({ k: "v2.catalog", default: draft.model.default.get(), providers })
      })
    } catch (e: any) { log({ k: "v2.catalog.error", err: String(e?.message ?? e) }) }
  },
}

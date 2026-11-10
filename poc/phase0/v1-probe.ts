// Phase 0 probe (V1 hooks): E3 chat.message model rewrite, E6 subagent input, E9 event timing.
// Writes JSONL to $OAMP_POC_LOG. Never logs headers' values except x-opencode-* key names, never logs credentials.
import { appendFileSync } from "node:fs"

const LOG = process.env.OAMP_POC_LOG ?? "/tmp/oamp-poc/log.jsonl"
const log = (rec: Record<string, unknown>) => {
  try { appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...rec }) + "\n") } catch {}
}

export const OampPhase0V1 = async (input: any) => {
  log({ k: "v1.init", pid: process.pid, inputKeys: Object.keys(input ?? {}), project: input?.project?.id ? "present" : "absent" })
  // E8: bun:sqlite availability + multi-process WAL writes
  if (process.env.OAMP_POC_SQLITE) {
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(process.env.OAMP_POC_SQLITE, { create: true })
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS w(pid INTEGER, i INTEGER, ts INTEGER)")
      const ins = db.prepare("INSERT INTO w VALUES (?,?,?)")
      for (let i = 0; i < 200; i++) ins.run(process.pid, i, Date.now())
      log({ k: "sqlite.ok", rows: (db.query("SELECT count(*) AS n FROM w").get() as any).n })
      db.close()
    } catch (e: any) { log({ k: "sqlite.error", err: String(e?.message ?? e) }) }
  }
  const tuiKeys = Object.keys((input?.client as any)?.tui ?? {})
  log({ k: "client.tui", keys: tuiKeys, sessionKeys: Object.keys((input?.client as any)?.session ?? {}).slice(0, 40) })
  const hooks: any = {
    "chat.message": async (inp: any, out: any) => {
      const before = out?.message?.model
      const target = process.env.OAMP_POC_TARGET // "provider/model"
      let after: unknown = undefined
      if (inp?.model?.providerID === "oamp" && target) {
        const i = target.indexOf("/")
        out.message.model = { ...out.message.model, providerID: target.slice(0, i), modelID: target.slice(i + 1) }
        after = out.message.model
      }
      log({ k: "chat.message", sessionID: inp?.sessionID, agent: inp?.agent, inModel: inp?.model, variant: inp?.variant,
            msgKeys: Object.keys(out?.message ?? {}), before, after })
    },
    "chat.headers": async (inp: any, out: any) => {
      log({ k: "chat.headers", sessionID: inp?.sessionID, agent: inp?.agent,
            model: { providerID: inp?.model?.providerID, id: inp?.model?.id }, userModel: inp?.message?.model })
    },
    event: async ({ event }: any) => {
      const t = event?.type
      const p = event?.properties ?? {}
      if (t === "message.updated") {
        const m = p.info ?? {}
        log({ k: "ev.message", role: m.role, sessionID: m.sessionID, id: m.id, providerID: m.providerID, modelID: m.modelID,
              model: m.model, time: m.time, finish: m.finish, tokens: m.tokens, error: m.error ? { name: m.error.name, status: m.error?.data?.statusCode } : undefined })
      } else if (t === "message.part.updated") {
        const part = p.part ?? {}
        log({ k: "ev.part", sessionID: part.sessionID, messageID: part.messageID, id: part.id, type: part.type, time: part.time,
              tool: part.tool, state: part.state?.status })
      } else if (t && /session\.(status|error|created|idle)/.test(t)) {
        log({ k: "ev." + t, props: JSON.parse(JSON.stringify(p, (key, v) => (key === "content" || key === "text" ? undefined : v))) })
      }
    },
  }
  // Discovery tests: config hook (in-memory config mutation) and provider.models hook
  hooks.config = async (cfg: any) => {
    const x = cfg?.provider?.xkiro
    log({ k: "config.hook", providers: Object.keys(cfg?.provider ?? {}), xkiroModels: Object.keys(x?.models ?? {}).length, xkiroWhitelist: x?.whitelist?.length })
    if (process.env.OAMP_POC_CFG_DROP_WL && x) { delete x.whitelist; log({ k: "config.hook.mutated" }) }
  }
  if (process.env.OAMP_POC_PROVIDER_HOOK) {
    hooks.provider = {
      id: "xkiro",
      models: async (provider: any, ctx: any) => {
        const ids = Object.keys(provider?.models ?? {})
        log({ k: "provider.hook", id: provider?.id, existing: ids.length, sample: ids.slice(0, 3), sampleModel: ids[0] ? Object.keys(provider.models[ids[0]]) : [] })
        const base = ids[0] ? provider.models[ids[0]] : undefined
        if (!base) return provider?.models ?? {}
        const extra = { ...base, id: "oamp-poc/injected", name: "oamp-poc injected", api: { ...base.api, id: "mistralai/ministral-3b" } }
        return { ...provider.models, "oamp-poc/injected": extra }
      },
    }
  }
  return hooks
}

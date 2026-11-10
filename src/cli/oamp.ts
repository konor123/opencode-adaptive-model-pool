// oamp CLI: deterministic inspection without going through an LLM (plan v1.3 §9).
//   oamp status | oamp routes [--all] [--provider p] | oamp refresh [--force] | oamp bootstrap
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { applyAndSync, refreshProviderModels } from "../discovery/pipeline.ts"
import { loadModelsDev } from "../discovery/models-dev.ts"
import { initLog } from "../log.ts"
import { resolveOptions } from "../options.ts"
import { kvGet, kvSet, openDb } from "../storage/db.ts"
import { bootstrapFromOpencodeDb } from "../telemetry/bootstrap.ts"

/** Strip // and /* *\/ comments outside strings, and trailing commas. */
export function parseJsonc(text: string): any {
  let out = ""
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const n = text[i + 1]
    if (inStr) {
      out += c
      if (c === "\\") { out += n ?? ""; i++ } else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

function deepMerge(a: any, b: any): any {
  if (!a || typeof a !== "object" || Array.isArray(a) || !b || typeof b !== "object" || Array.isArray(b)) return b ?? a
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v
  return out
}

export function loadOpencodeConfig(): any {
  const files = [join(homedir(), ".config/opencode/opencode.jsonc"), join(homedir(), ".config/opencode/opencode.json")]
  if (process.env.OPENCODE_CONFIG) files.push(process.env.OPENCODE_CONFIG)
  let cfg: any = {}
  for (const f of files) if (existsSync(f)) cfg = deepMerge(cfg, parseJsonc(readFileSync(f, "utf8")))
  return cfg
}

export function oampPluginOptions(cfg: any): unknown {
  for (const entry of cfg?.plugin ?? []) {
    if (Array.isArray(entry) && String(entry[0]).includes("opencode-adaptive-model-pool")) return entry[1]
  }
  return undefined
}

const pad = (s: unknown, n: number) => String(s ?? "").padEnd(n).slice(0, n)

async function main(argv: string[]) {
  const [cmd = "status", ...rest] = argv
  const cfg = loadOpencodeConfig()
  const opts = resolveOptions(oampPluginOptions(cfg))
  initLog(opts.storage.path)
  const db = openDb(opts.storage.path)
  const flag = (f: string) => rest.includes(f)
  const arg = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined }

  if (cmd === "refresh") {
    const r = await refreshProviderModels(db, opts, cfg, { force: flag("--force"), holder: `cli:${process.pid}` })
    const s = applyAndSync(db, opts, cfg, loadModelsDev(opts.paths.modelsDevCache))
    console.log(JSON.stringify({ providers: r, inject: s.inject, sync: s.sync, routes: s.routes, eligible: s.eligible }, null, 2))
    return
  }
  if (cmd === "bootstrap") {
    const r = bootstrapFromOpencodeDb(db, opts.paths.opencodeDb)
    kvSet(db, "bootstrap:done", JSON.stringify({ at: Date.now(), ...r }))
    console.log(JSON.stringify(r))
    return
  }
  if (cmd === "routes") {
    const where: string[] = []
    const params: string[] = []
    if (!flag("--all")) where.push("status = 'active'")
    const p = arg("--provider")
    if (p) { where.push("provider_id = ?"); params.push(p) }
    const rows = db.query(`SELECT * FROM routes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY eligible DESC, provider_id, model_id`).all(...params) as any[]
    console.log(`${pad("route", 58)} ${pad("status", 8)} ${pad("price", 14)} ${pad("elig", 4)} ${pad("tools", 5)} ${pad("ctx", 8)} ${pad("canonical (conf)", 46)} reasons`)
    for (const r of rows)
      console.log(`${pad(r.route_id, 58)} ${pad(r.status, 8)} ${pad(r.price_state, 14)} ${pad(r.eligible ? "yes" : "no", 4)} ${pad(r.tools === null ? "?" : r.tools ? "yes" : "no", 5)} ${pad(r.ctx_limit ?? "", 8)} ${pad(`${r.canonical_id} (${r.match_conf})`, 46)} ${r.ineligible}`)
    console.log(`${rows.length} routes`)
    return
  }
  // status
  const byProv = db.query(`SELECT provider_id, status, count(*) n, sum(eligible) e FROM routes GROUP BY provider_id, status ORDER BY provider_id`).all() as any[]
  console.log("OAMP status  db:", opts.storage.path)
  console.log("\nroutes by provider:")
  for (const r of byProv) console.log(`  ${pad(r.provider_id, 12)} ${pad(r.status, 8)} total=${pad(r.n, 4)} eligible=${r.e}`)
  console.log("\nprovider model sync:")
  for (const pid of Object.keys(opts.providerSync)) console.log(`  ${pad(pid, 12)} ${kvGet(db, `provider-sync:${pid}`) ?? "never"}`)
  console.log("\ncatalog last sync:", kvGet(db, "catalog:last-sync") ?? "never")
  console.log("history bootstrap:", kvGet(db, "bootstrap:done") ?? "not yet")
  const hist = db.query(`SELECT count(*) n, count(DISTINCT route_id) r FROM request_metrics WHERE kind='history'`).get() as any
  console.log(`request_metrics(history): ${hist.n} rows over ${hist.r} routes`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("oamp:", e?.message ?? e)
    process.exit(1)
  })
}

// oamp CLI: deterministic inspection without going through an LLM (plan v1.3 §9).
//   oamp status | routes [--all] [--provider p] | refresh [--force] | usage [--full] | bench [--force]
//   | rank [pool] | perf | decisions [--limit n] | model <route> | health | probe <route>
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { applyAndSync, refreshProviderModels } from "../discovery/pipeline.ts"
import { loadModelsDev } from "../discovery/models-dev.ts"
import { initLog } from "../log.ts"
import { resolveOptions } from "../options.ts"
import { kvGet, kvSet, openDb } from "../storage/db.ts"
import { refreshBenchmarks } from "../benchmarks/refresh.ts"
import { computePerformanceScores } from "../scoring/compute.ts"
import { computeRouteScores } from "../scoring/routes.ts"
import { probeRoute } from "../health/probe.ts"
import { loadHealth, recordOutcome, verdict } from "../scoring/health.ts"
import { importUsage } from "../telemetry/usage-import.ts"

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
  if (cmd === "bench") {
    const b = await refreshBenchmarks(db, opts, cfg, { force: flag("--force"), holder: `cli:${process.pid}` })
    const s = computePerformanceScores(db, opts, loadModelsDev(opts.paths.modelsDevCache)?.openrouter?.models)
    console.log(JSON.stringify({ benchmarks: b, scored: s.length, withEvidence: s.filter((x) => x.result.used.length).length }, null, 2))
    return
  }
  if (cmd === "rank") {
    // oamp rank [pool] — final route score R = (w_p·P_eff + w_l·L) × H, health-gated (what the selector uses)
    const pool = rest.find((a) => !a.startsWith("--")) ?? "auto"
    const scores = computeRouteScores(db, opts).filter((s) => s.pool === pool).sort((a, b) => b.r - a.r)
    console.log(`pool ${pool}`)
    console.log(`${pad("#", 3)} ${pad("route", 52)} ${pad("R", 6)} ${pad("P_eff", 6)} ${pad("L", 6)} ${pad("H", 5)} ${pad("n", 5)} health`)
    scores.forEach((s, i) =>
      console.log(`${pad(i + 1, 3)} ${pad(s.routeID, 52)} ${pad(s.r.toFixed(1), 6)} ${pad(s.pEff.toFixed(1), 6)} ${pad(s.l.toFixed(1), 6)} ${pad(s.h.toFixed(2), 5)} ${pad(s.samples, 5)} ${s.health.state}${s.health.until ? ` until ${new Date(s.health.until).toISOString()}` : ""}`))
    console.log(`${scores.length} eligible routes. Benchmark data: Artificial Analysis (artificialanalysis.ai), OpenRouter (openrouter.ai).`)
    return
  }
  if (cmd === "perf") {
    const rows = db.query(`SELECT r.route_id, s.p, s.p_eff, s.c, s.detail_json FROM routes r JOIN scores s ON s.route_id = r.route_id AND s.pool = 'auto'
      WHERE r.status = 'active' AND r.eligible = 1 ORDER BY s.p_eff DESC`).all() as any[]
    console.log(`${pad("#", 3)} ${pad("route", 56)} ${pad("P_eff", 6)} ${pad("P", 6)} ${pad("c", 5)} ${pad("C/A/I", 17)} evidence`)
    rows.forEach((r, i) => {
      const d = JSON.parse(r.detail_json ?? "{}")
      const cat = d.categories ? `${d.categories.C.score.toFixed(0)}${d.categories.C.proxy ? "*" : ""}/${d.categories.A.score.toFixed(0)}/${d.categories.I.score.toFixed(0)}` : ""
      console.log(`${pad(i + 1, 3)} ${pad(r.route_id, 56)} ${pad((r.p_eff ?? 0).toFixed(1), 6)} ${pad((r.p ?? 0).toFixed(1), 6)} ${pad((r.c ?? 0).toFixed(2), 5)} ${pad(cat, 17)} ${(d.used ?? []).join(",")}`)
    })
    return
  }
  if (cmd === "health") {
    const now = Date.now()
    const rows = [...loadHealth(db).values()].sort((a, b) => (b.lastErrorAt ?? 0) - (a.lastErrorAt ?? 0))
    for (const h of rows) {
      const v = verdict(h, now)
      console.log(`${pad(h.routeID, 52)} ${pad(v.state, 10)} fails=${pad(h.consecutiveFail, 3)} opens=${pad(h.opens, 2)} ${pad(h.errorClass ?? "", 11)} ${v.until ? "until " + new Date(v.until).toISOString() : ""}`)
    }
    console.log(`${rows.length} routes with health history (others are healthy)`)
    return
  }
  if (cmd === "probe") {
    const route = rest[0]
    if (!route || !db.query("SELECT 1 FROM routes WHERE route_id = ?").get(route)) { console.log("usage: oamp probe <known route id>"); return }
    const r = await probeRoute(route)
    const h = recordOutcome(db, route, r.ok ? undefined : r.error === "timeout" ? "timeout" : "server")
    console.log(JSON.stringify({ route, ...r, health: verdict(h, Date.now()) }))
    return
  }
  if (cmd === "decisions") {
    const rows = db.query("SELECT ts, pool, substr(session_hash,1,10) s, chosen_route, reason, top4_json FROM rank_history ORDER BY id DESC LIMIT ?").all(Number(arg("--limit") ?? 20)) as any[]
    for (const r of rows) console.log(`${new Date(r.ts).toISOString()} ${pad(r.pool, 5)} ${r.s} ${pad(r.chosen_route, 46)} ${pad(r.reason, 15)} ${r.top4_json}`)
    return
  }
  if (cmd === "model") {
    const id = rest[0]
    const r = db.query("SELECT * FROM routes WHERE route_id = ?").get(id ?? "") as any
    if (!r) { console.log("unknown route", id); return }
    const s = db.query("SELECT * FROM scores WHERE route_id = ? AND pool = 'auto'").get(r.route_id) as any
    const h = db.query(`SELECT count(*) n, sum(outcome='ok') ok, sum(outcome='error') err, avg(e2e_ms) e2e, avg(tps) tps FROM request_metrics WHERE route_id = ?`).get(r.route_id) as any
    console.log(JSON.stringify({ route: { ...r, meta_json: JSON.parse(r.meta_json) }, score: s ? { ...s, detail_json: JSON.parse(s.detail_json ?? "{}") } : null, history: h }, null, 2))
    return
  }
  if (cmd === "usage") {
    // full re-import of real usage from opencode.db (idempotent upsert), then rescore
    const r = importUsage(db, opts.paths.opencodeDb, { sinceMs: flag("--full") ? 0 : Math.max(0, Number(kvGet(db, "usage:cursor") ?? 0) - 3 * 3_600_000) })
    kvSet(db, "usage:cursor", String(r.cursor))
    kvSet(db, "usage:last", JSON.stringify({ at: Date.now(), ...r }))
    const s = computePerformanceScores(db, opts, loadModelsDev(opts.paths.modelsDevCache)?.openrouter?.models)
    console.log(JSON.stringify({ usage: r, scored: s.length, withEvidence: s.filter((x) => x.result.used.length).length }))
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
  console.log("usage import:", kvGet(db, "usage:last") ?? "not yet")
  console.log("benchmarks openrouter:", kvGet(db, "bench-sync:openrouter") ?? "never")
  console.log("benchmarks aa:", kvGet(db, "bench-sync:aa") ?? "never")
  console.log("scores:", kvGet(db, "scores:last") ?? "never")
  const hist = db.query(`SELECT count(*) n, count(DISTINCT route_id) r, sum(tool_calls) t FROM request_metrics WHERE kind='history'`).get() as any
  console.log(`request_metrics(history): ${hist.n} steps over ${hist.r} routes, ${hist.t ?? 0} tool calls`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("oamp:", e?.message ?? e)
    process.exit(1)
  })
}

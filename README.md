# OpenCode Adaptive Model Pool (OAMP)

An [OpenCode](https://opencode.ai) plugin that keeps a pool of models across providers and ranks them by public benchmarks and measured latency. When you pick the marker model `oamp/auto`, OAMP chooses the real model for each turn. Model calls always go through OpenCode itself, so OpenCode-only free models keep working.

Status: **Phase 5** (all planned phases implemented). Model selection via `oamp/auto` (route score R = (0.7·P_eff + 0.3·L) × H) comes with live latency telemetry, sticky sessions, subagent inheritance, a route health state machine (cooldown, circuit breaker, probation), and in-turn failover. In the TUI and `opencode serve`, a turn whose route starts failing is aborted and continued on the next healthy route. Under `opencode run` the in-turn switch is off, because `run` exits when its session is aborted. There the failed route is avoided from the next run on. See `docs/plan-v1.3.md` and `docs/compatibility.md`.

## What Phase 1 does

- **Provider model sync**: for config-defined providers with a `/v1/models` endpoint (`xkiro`, `exaone`), OAMP fetches the model list in the background every 6 h and caches it. It injects the list into OpenCode's *in-memory* config through the V1 `config` hook. The config file on disk is never written. A provider `whitelist` that would hide every model is dropped in memory.
- **Route registry**: OAMP builds the effective catalog (models.dev cache plus config, with OpenCode's whitelist, blacklist and deprecated filters applied) and stores one route per `provider/model` in SQLite. A route missing from the catalog once is marked stale. Missing twice, it is retired.
- **Policy**: each route gets a price state (`free_verified`, `free_quota`, `free_declared`, `paid`, `unknown`) and an eligibility decision (tool calling, text output, price, deny list).
- **Real-usage import**: OAMP reads OpenCode's `opencode.db` *read-only* and incrementally. Every assistant step becomes a metrics row: latency, tokens, error class, and tool-call outcomes. It stores hashed ids and numbers only.

## Using it

Pick **`oamp/auto`** (or `oamp/fast`) in the TUI model picker, or run `opencode run --model oamp/auto "…"`. Each turn, OAMP replaces the marker with the best healthy route, and OpenCode makes the call itself. The session stays on that route unless the route fails, a clearly better one stays better for 30 minutes, or the context no longer fits. Picking any real model switches the session to manual.

## Phase 2: performance score

- **Benchmarks**: OpenRouter Benchmarks (`/api/v1/benchmarks`, using the existing OpenRouter key) supplies the Artificial Analysis coding, agentic and intelligence indices plus OpenRouter's own GPQA and tau-bench results. The Artificial Analysis free API (key file `~/.config/oamp/aa-api-key`) adds the intelligence index and model-level speed priors. When both sources carry the same AA measurement, only one copy is used.
- **Score**: `P = 0.55·C + 0.30·A + 0.15·I`. Every indicator is normalized against a reference range (p5/p95) that is frozen the first time the population is seen. Confidence `c = coverage × match × recency × independence`, and `P_eff = c·P + (1−c)·prior`, where the prior is the median P of the pool's evidenced routes.
- **Real usage**: two indicators come from your own OpenCode history over the last 30 days, counting model-caused failures only. `usage_tools` is the share of tool calls with schema-valid arguments. `usage_edit` is the share of edit and write calls that did not fail with schema errors or a missing `oldString`.

Benchmark data: Artificial Analysis (artificialanalysis.ai) and OpenRouter (openrouter.ai). Specialist leaderboards without an API (Scale Labs SWE-Bench Pro V2, MCP Atlas) are included as dated snapshots in `data/snapshots/`.

## Install

```sh
git clone https://github.com/konor123/opencode-adaptive-model-pool && cd opencode-adaptive-model-pool
scripts/oamp install      # adds only the plugin entry to ~/.config/opencode/opencode.jsonc (backup kept)
scripts/oamp doctor       # verifies installation, providers, data freshness, recent errors
```

`install` and `uninstall` change nothing but the `plugin` entry. They only edit the file if it round-trips byte-for-byte as standard JSON; otherwise they print the line to add by hand. Equivalent manual configuration:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": [
    ["file:///path/to/opencode-adaptive-model-pool/src/index.ts", { "enabled": true }]
  ]
}
```

Options (all optional) are documented in `src/options.ts`. Defaults: providers `opencode, openrouter, nvidia, xkiro, exaone`, `allowPaid: false`, `freeDeclared: ["xkiro/*", "exaone/*"]`, DB at `~/.local/share/oamp/oamp.db`, log at `~/.local/share/oamp/oamp.log`.

To uninstall, run `scripts/oamp uninstall` (or remove the entry). OAMP's data stays in `~/.local/share/oamp` until you delete it.

## CLI

```sh
scripts/oamp status            # routes per provider, sync, usage import, benchmark and score state
scripts/oamp routes [--all] [--provider xkiro]
scripts/oamp refresh [--force] # fetch provider model lists now and rebuild routes
scripts/oamp usage [--full]    # import real usage from opencode.db (incremental; --full re-reads everything), rescore
scripts/oamp bench [--force]   # fetch OpenRouter + Artificial Analysis benchmarks, recompute scores
scripts/oamp rank [pool]       # what the selector uses: R, P_eff, L, H, samples, health
scripts/oamp perf              # performance only: P_eff with C/A/I breakdown and evidence
scripts/oamp decisions         # recent selector decisions with reasons
scripts/oamp health            # route health states (cooldown / open / disabled / probation)
scripts/oamp probe <route>     # one tiny request through `opencode run`; updates health, deletes the probe session
scripts/oamp stats [--days 7]  # KPIs (unintended paid calls, auto-session outcomes, decisions) + benchmark-vs-usage correlation
scripts/oamp doctor            # installation and health checklist (non-zero exit on failure)
scripts/oamp install | uninstall
scripts/oamp model <route>     # full detail for one route
```

`scripts/bun` runs the Bun runtime embedded in OpenCode (`BUN_BE_BUN=1 opencode`), which is the same runtime the plugin runs in.

## Development

```sh
npm install          # dev types only
scripts/bun test     # unit tests
npx tsc --noEmit -p .
```

Security notes: provider API keys are resolved from the provider's config (`{file:…}` and `{env:…}` references supported) or from OpenCode's `auth.json`. Keys are used only for the fixed HTTPS model-list endpoints, with redirects refused. They are never logged or stored.

# OpenCode Adaptive Model Pool (OAMP)

An [OpenCode](https://opencode.ai) plugin that keeps a pool of models across providers and ranks them by public benchmarks and measured latency. When you pick the marker model `oamp/auto`, OAMP chooses the real model for each turn. Model calls always go through OpenCode itself, so OpenCode-only free models keep working.

Status: **Phase 3**. Model selection via `oamp/auto` works: route scores R = (0.7·P_eff + 0.3·L) × H, live latency telemetry, sticky sessions, subagent inheritance, and cooldowns for failing routes. Phase 4 adds a full circuit breaker, probes and in-turn failover experiments. See `docs/plan-v1.3.md` and `docs/compatibility.md`.

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

Benchmark data: Artificial Analysis (artificialanalysis.ai) and OpenRouter (openrouter.ai).

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": [
    ["file:///path/to/opencode-adaptive-model-pool/src/index.ts", { "enabled": true }]
  ]
}
```

Options (all optional) are documented in `src/options.ts`. Defaults: providers `opencode, openrouter, nvidia, xkiro, exaone`, `allowPaid: false`, `freeDeclared: ["xkiro/*", "exaone/*"]`, DB at `~/.local/share/oamp/oamp.db`, log at `~/.local/share/oamp/oamp.log`.

To uninstall, remove the `plugin` entry. Nothing else in your config is changed.

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

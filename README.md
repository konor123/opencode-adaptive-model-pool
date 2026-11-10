# OpenCode Adaptive Model Pool (OAMP)

An [OpenCode](https://opencode.ai) plugin that keeps a pool of models across providers and ranks them by public benchmarks and measured latency. When you pick the marker model `oamp/auto`, OAMP chooses the real model for each turn. Model calls always go through OpenCode itself, so OpenCode-only free models keep working.

Status: **Phase 2** (discovery, route registry, price/capability policy, history bootstrap, benchmark ingestion, performance score, self-evaluation). Model selection (`oamp/auto`) arrives in Phase 3. See `docs/plan-v1.3.md` and `docs/compatibility.md`.

## What Phase 1 does

- **Provider model sync**: for config-defined providers with a `/v1/models` endpoint (`xkiro`, `exaone`), OAMP fetches the model list in the background every 6 h and caches it. It injects the list into OpenCode's *in-memory* config through the V1 `config` hook. The config file on disk is never written. A provider `whitelist` that would hide every model is dropped in memory.
- **Route registry**: OAMP builds the effective catalog (models.dev cache plus config, with OpenCode's whitelist, blacklist and deprecated filters applied) and stores one route per `provider/model` in SQLite. A route missing from the catalog once is marked stale. Missing twice, it is retired.
- **Policy**: each route gets a price state (`free_verified`, `free_quota`, `free_declared`, `paid`, `unknown`) and an eligibility decision (tool calling, text output, price, deny list).
- **History bootstrap**: on first run OAMP reads OpenCode's `opencode.db` *read-only* and records per-route latency and error priors. It stores hashed ids and numbers only.

## Phase 2: performance score

- **Benchmarks**: OpenRouter Benchmarks (`/api/v1/benchmarks`, using the existing OpenRouter key) supplies the Artificial Analysis coding, agentic and intelligence indices plus OpenRouter's own GPQA and tau-bench results. The Artificial Analysis free API (key file `~/.config/oamp/aa-api-key`) adds the intelligence index and model-level speed priors. When both sources carry the same AA measurement, only one copy is used.
- **Score**: `P = 0.55·C + 0.30·A + 0.15·I`. Every indicator is normalized against a reference range (p5/p95) that is frozen the first time the population is seen. Confidence `c = coverage × match × recency × independence`, and `P_eff = c·P + (1−c)·prior`, where the prior is the median P of the pool's evidenced routes.
- **Self-evaluation**: four small sandboxed tasks (two coding, two tool use), checked by deterministic verifiers and run through `opencode run`. Runs where OpenCode itself failed are not scored.

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
scripts/oamp status            # routes per provider, sync state, bootstrap state
scripts/oamp routes [--all] [--provider xkiro]
scripts/oamp refresh [--force] # fetch provider model lists now and rebuild routes
scripts/oamp bootstrap         # re-run the opencode.db history import (idempotent)
scripts/oamp bench [--force]   # fetch OpenRouter + Artificial Analysis benchmarks, recompute scores
scripts/oamp rank [--all]      # routes by P_eff with C/A/I breakdown and evidence
scripts/oamp model <route>     # full detail for one route
scripts/oamp selfeval --route <r> | --missing N   # run the self-evaluation tasks through `opencode run`
```

`scripts/bun` runs the Bun runtime embedded in OpenCode (`BUN_BE_BUN=1 opencode`), which is the same runtime the plugin runs in.

## Development

```sh
npm install          # dev types only
scripts/bun test     # unit tests
npx tsc --noEmit -p .
```

Security notes: provider API keys are resolved from the provider's config (`{file:…}` and `{env:…}` references supported) or from OpenCode's `auth.json`. Keys are used only for the fixed HTTPS model-list endpoints, with redirects refused. They are never logged or stored.

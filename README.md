# OpenCode Adaptive Model Pool (OAMP)

English | [한국어](README.ko.md)

OAMP is an [OpenCode](https://opencode.ai) plugin. It keeps a pool of models across your providers, ranks them by public benchmarks, your own real-usage quality and measured latency, and avoids routes that are failing. Pick the marker model **`oamp/auto`** and OAMP chooses the real model for every turn. The call itself is still made by OpenCode.

Status: all planned phases (0–5) are implemented. The design history (in Korean) is in [`docs/`](docs/).

## How it works

```text
you pick oamp/auto ──▶ chat.message hook ──▶ OAMP replaces the marker with the best healthy route
                                             (e.g. opencode/deepseek-v4.1-flash-free) for this turn
                                                     │
                                OpenCode calls that route itself: its own SDK instance, headers and auth
                                                     │
            event / chat.headers hooks ◀── telemetry: TTFT, TTFA, E2E, tokens/s, errors, retries
```

- **No proxy.** OAMP never sends model requests itself. That matters for providers that only accept calls made by OpenCode, such as OpenCode Zen's free models: OpenCode attaches its own `x-opencode-*` headers only to its own providers.
- `oamp/*` models exist only in memory. A `config` hook injects a marker provider whose base URL is a discard port, so the markers are never meant to be called.
- Choosing any real model in a session turns auto mode off for that session. Your manual choice always wins.

## Requirements

- OpenCode **1.19.5** (the version this was verified on; see [`docs/compatibility.md`](docs/compatibility.md)). OAMP uses only OpenCode's **V1 plugin hooks**, because OpenCode 1.19.5 does not load external V2 plugins.
- No `npm install` is needed to run it. The plugin and CLI run on the Bun runtime embedded in OpenCode: `scripts/bun` = `BUN_BE_BUN=1 ~/.opencode/bin/opencode`. Override the binary path with `OPENCODE_BIN`.
- The source imports only `node:*` and `bun:sqlite`. Python 3 is not required.

## Install, check, uninstall

```sh
git clone https://github.com/konor123/opencode-adaptive-model-pool
cd opencode-adaptive-model-pool
scripts/oamp install     # adds one "plugin" entry to ~/.config/opencode/opencode.jsonc (a backup is kept)
scripts/oamp doctor      # installation, options, schema, providers, data freshness, recent errors
# restart OpenCode, then pick oamp/auto
scripts/oamp uninstall   # removes that entry again
```

`install` and `uninstall` touch nothing but the `plugin` entry. They only edit the file when it round-trips byte-for-byte as standard 2-space JSON. A file with comments or other formatting is left alone, and they print the line to add by hand:

```jsonc
{
  "plugin": [
    ["file:///path/to/opencode-adaptive-model-pool/src/index.ts", { "enabled": true }]
  ]
}
```

OAMP keeps its data in `~/.local/share/oamp/` (`oamp.db`, `oamp.log`). Delete that directory to remove every trace.

## Using it

- **`oamp/auto`**: the default pool. **`oamp/fast`**: the same candidates, with latency weighted more heavily.
- Select a marker in the TUI model picker (`/models`), in an agent's `model` field, or with `opencode run --model oamp/auto "…"`.
- **Sticky sessions.** A session keeps its route. It switches only when:
  - the route becomes unhealthy,
  - the context no longer fits the route,
  - a route limit applies,
  - or another route has stayed at least 5 points better for 30 minutes.
- **First turns.** The first turn of a new session sometimes (5% of the time) tries a route with little evidence. Such a route must not be known to be weak.
- **Subagents.** Subagents (the task tool) inherit auto mode from their parent session.

## Scoring

| Score | Definition |
|---|---|
| Performance `P` | `0.55·C + 0.30·A + 0.15·I` (coding, agentic, reasoning). Each category is a weighted mean of whichever indicators exist; the weights are in [`src/scoring/performance.ts`](src/scoring/performance.ts). |
| Confidence `c` | `coverage × match × recency × independence` |
| `P_eff` | `c·P + (1−c)·prior`. The prior is the median `P` of the pool's routes that have evidence, so a model with no evidence is assumed to be typical for the pool rather than "50 out of 100". |
| Latency `L` | `0.35·TTFA + 0.45·E2E + 0.20·tokens/s`, log-scaled, EWMA, shrunk toward neutral for routes with few samples |
| Availability `H` | `clamp(success_ewma, 0.5, 1)²` over the latest outcomes. User aborts and context overflows are not counted. |
| Route score `R` | `(0.7·P_eff + 0.3·L) × H`. The `fast` pool uses 0.4 / 0.6. |

Evidence sources:

- **OpenRouter Benchmarks API**, using your existing OpenRouter key. It re-serves the Artificial Analysis coding, agentic and intelligence indices and adds OpenRouter's own GPQA Diamond and tau-bench results.
- **Artificial Analysis free API**. Optional; the key file is `~/.config/oamp/aa-api-key`. It provides the intelligence index and model-level speed priors. When both sources carry the same AA measurement, only one copy is used.
- **Specialist leaderboards without an API** (Scale Labs SWE-Bench Pro V2, MCP Atlas). These are stored as dated snapshots in [`data/snapshots/`](data/snapshots/). Each file holds the whole leaderboard as the normalization population, with hand-checked name mappings.
- **Your own real usage** from OpenCode's `opencode.db`, read-only, over the last 30 days. Only model-caused failures count against a model.
  - `usage_tools`: the share of tool calls with schema-valid arguments. Needs at least 30 calls.
  - `usage_edit`: the share of edit, write and patch calls that did not fail on a schema error or a missing `oldString`. Needs at least 20 calls.

All benchmark indicators are normalized against a p5/p95 reference range. The range is frozen the first time each source version is seen, so adding or removing models does not shift existing scores.

## When a route fails

- **Health states** are shared by every OpenCode process on the host:
  - A transient error starts a **cooldown**: 60, 120, 240, then 300 s.
  - The third consecutive failure **opens** the route: 120 s, doubling on every re-open, up to 30 min.
  - A 401, 403 or 404 **disables** the route for 24 h. A 401 disables every route of that provider.
  - When any of these periods expires, the route is on **probation**. A probation route is used only when nothing healthy fits; a success there makes it healthy again.
- **In-turn failover** in the TUI and `opencode serve`:
  1. OpenCode starts retrying the same model in an auto session.
  2. OAMP aborts the turn.
  3. OAMP continues the turn on the next healthy route with a short synthetic "continue" message, at most twice per turn.

  OAMP never replays a request itself. Steps that already ran stay in the history, so their tools are not executed twice.
- **Under `opencode run`** in-turn failover is off. `run` exits as soon as its session is aborted, so the continued answer would never be printed. OpenCode's own retries handle the failure, and the failed route is avoided from the next run on.
- **Route limits.** `routeLimits` caps the number of concurrent auto sessions per route; EXAONE allows 1 request per second. A route is also limited to one session automatically when more than 20% of its requests in the last 10 minutes were rate-limited.

## Configuration

Every option is optional. They are passed as the second element of the plugin entry, and the full list with defaults is in [`src/options.ts`](src/options.ts). Invalid numeric values (negative, NaN, weight groups summing to zero) fall back to the defaults, and `oamp doctor` reports them.

The defaults reflect the deployment this was built for: providers `opencode`, `openrouter`, `nvidia`, plus two OpenAI-compatible providers `xkiro` and `exaone`. Adapt them for your setup:

```jsonc
["file:///path/to/opencode-adaptive-model-pool/src/index.ts", {
  "providers": ["opencode", "openrouter"],
  "policy": {
    "allowPaid": false,           // never select a route with a known price
    "allowUnknownPrice": false,   // ...or one without any price information
    "freeDeclared": [],           // "provider/*" globs you know to be free
    "deny": ["openrouter/openrouter/free"]
  },
  "providerSync": {},             // provider /v1/models sync (fixed endpoints in src/discovery/provider-api.ts)
  "weights": { "performance": 0.7, "latency": 0.3 },
  "pools": { "auto": {}, "fast": { "weights": { "performance": 0.4, "latency": 0.6 } } },
  "selector": { "switchMargin": 5, "switchHoldMinutes": 30, "explorationBudget": 0.05, "inTurnFailover": true, "maxSwitchesPerTurn": 2 },
  "routeLimits": { "exaone/*": { "maxSessions": 1 } }
}]
```

Provider model-list sync (`providerSync`) only calls the fixed HTTPS endpoints listed in `src/discovery/provider-api.ts`. It replaced a cron job that rewrote the config file. OAMP never writes your config file; the lists are injected in memory at startup.

The environment variable `OAMP_OPTIONS='{"…": …}'` overrides options for a process. This is useful for testing against a separate database: `{"storage": {"path": "/tmp/test.db"}}`.

## CLI

```sh
# inspect
scripts/oamp status                 # routes per provider, sync, usage import, benchmark and score state
scripts/oamp rank [auto|fast]       # what the selector sees: R, P_eff, L, H, samples, health
scripts/oamp perf                   # P_eff with C/A/I breakdown and the evidence behind it
scripts/oamp routes [--all] [--provider p]
scripts/oamp model <route>          # everything known about one route
scripts/oamp decisions [--limit n]  # recent selector decisions with reasons
scripts/oamp health                 # cooldown / open / disabled / probation states
scripts/oamp stats [--days 7]       # KPIs (e.g. unintended paid calls) and benchmark-vs-usage correlation

# refresh (the plugin also does this in the background, leased across processes)
scripts/oamp refresh [--force]      # provider model lists + route registry
scripts/oamp bench [--force]        # benchmarks + scores
scripts/oamp usage [--full]         # import real usage from opencode.db + rescore
scripts/oamp probe <route>          # one tiny request through `opencode run`; the probe session is deleted

# lifecycle
scripts/oamp install | uninstall | doctor
```

## Data, network and credentials

- **Stored**, in `~/.local/share/oamp/oamp.db` (SQLite in WAL mode, shared by all OpenCode processes):
  - routes and their catalog facts
  - benchmark numbers
  - per-step metrics
  - health states
  - selector decisions

  Session and message ids are stored only as SHA-256 hashes. Prompts, responses, headers and keys are never stored.
- **Read**, read-only:
  - OpenCode's `opencode.db`
  - the models.dev cache
  - OpenCode's `auth.json`, only to check which providers have a credential and to use your OpenRouter key for its Benchmarks API
- **Network**: OpenRouter Benchmarks, the Artificial Analysis API, and the fixed provider model-list endpoints. Every request uses HTTPS, a fixed URL, refuses redirects and has a timeout. Keys appear in no log, error message or database.

## Limitations

- In-turn failover cannot tell when a TUI is attached with `opencode run --attach`. Subagent sessions are excluded from it, because aborting a subagent would fail the parent's task call.
- Provider model lists injected through the `config` hook take effect the next time OpenCode starts.
- If the plugin is not loaded but `oamp/auto` is still selected, the request fails after about 65 s of OpenCode's own retries against the discard port.
- Specialist leaderboards cover very few free models (2 of 31 evidenced models on 2026-11-10). Terminal-Bench and BFCL render their tables client-side and are not collected.
- Real-usage indicators only appear once a model has enough tool calls. Until then a new model sits at the pool prior.
- `routeLimits.maxSessions` is counted, not reserved, so two processes starting at the same moment can briefly exceed it.

## Development

```sh
npm install                # dev dependencies only: TypeScript and type definitions
scripts/bun test           # unit tests (in-memory or temporary databases, fake fetch; no network)
npx tsc --noEmit -p .
```

- [`docs/plan-v1.3.md`](docs/plan-v1.3.md): design and per-phase results (Korean). Earlier plan versions sit next to it.
- [`docs/compatibility.md`](docs/compatibility.md): the OpenCode 1.19.5 behaviour this relies on.
- [`docs/reviews/`](docs/reviews/): an independent code review and the response to it.

## Attribution

Benchmark data comes from [Artificial Analysis](https://artificialanalysis.ai) and [OpenRouter](https://openrouter.ai/rankings). Specialist leaderboard snapshots come from [Scale Labs](https://labs.scale.com/leaderboard). Every source and retrieval date is recorded with its data.

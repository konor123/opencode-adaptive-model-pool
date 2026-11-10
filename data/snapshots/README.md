# Benchmark snapshots

Leaderboards that have no API (Scale Labs SWE-Bench Pro V2, MCP Atlas), stored as versioned, dated snapshots. Plan v1.0 §4.2 calls these "cached latest verified snapshots". OAMP loads every `*.json` file in this directory.

- `rows` holds the **whole leaderboard** as published. The reference range for normalization is its p5/p95 (frozen once per version).
- `map` links a leaderboard name to an OAMP canonical model id. Entries are added by hand and only after the names are checked (match confidence 1.0). Rows without a mapping only shape the reference range.
- A new leaderboard version goes into a new file with a new `version`, never into an existing file (plan §4.2: versions are separate series).
- Terminal-Bench 4.1 and BFCL V4 render their tables client-side, so the 2026-11-10 fetch had no rows to snapshot.

Coverage on 2026-11-10: SWE-Bench Pro V2 includes 1 model of the free pool (MiniMax M3.1 Flash). MCP Atlas includes 1 (Nemotron 3 Ultra).

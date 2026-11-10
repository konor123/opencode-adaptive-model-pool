// SQLite storage (bun:sqlite, WAL). Plan v1.3 §8. Never store prompts, responses, headers or credentials.
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE routes (
    route_id      TEXT PRIMARY KEY,
    provider_id   TEXT NOT NULL,
    model_id      TEXT NOT NULL,
    variant       TEXT NOT NULL DEFAULT '',
    canonical_id  TEXT NOT NULL,
    match_conf    REAL NOT NULL,
    source        TEXT NOT NULL,
    price_state   TEXT NOT NULL,
    eligible      INTEGER NOT NULL,
    ineligible    TEXT NOT NULL DEFAULT '',
    tools         INTEGER,
    reasoning     INTEGER,
    ctx_limit     INTEGER,
    out_limit     INTEGER,
    meta_json     TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL CHECK (status IN ('active','stale','retired','disabled')),
    miss_count    INTEGER NOT NULL DEFAULT 0,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX routes_provider ON routes(provider_id);
  CREATE INDEX routes_canonical ON routes(canonical_id);

  -- Cached provider /v1/models results (normalized CatalogModel JSON), used by the config hook.
  CREATE TABLE provider_models (
    provider_id TEXT PRIMARY KEY,
    models_json TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL
  );

  CREATE TABLE request_metrics (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,
    route_id    TEXT NOT NULL,
    session_hash TEXT,
    msg_hash    TEXT UNIQUE,
    kind        TEXT NOT NULL CHECK (kind IN ('primary','aux','probe','selfeval','history')),
    in_tokens   INTEGER,
    in_bucket   TEXT,
    ttft_ms     INTEGER,
    ttfa_ms     INTEGER,
    e2e_ms      INTEGER,
    out_tokens  INTEGER,
    tps         REAL,
    outcome     TEXT NOT NULL CHECK (outcome IN ('ok','error','aborted')),
    error_class TEXT,
    attempt_no  INTEGER
  );
  CREATE INDEX request_metrics_route ON request_metrics(route_id, ts);

  CREATE TABLE health_states (
    route_id TEXT PRIMARY KEY, state TEXT NOT NULL, error_class TEXT, consecutive_fail INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER, last_error_at INTEGER, last_ok_at INTEGER
  );
  CREATE TABLE benchmarks (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, benchmark TEXT NOT NULL, version TEXT, harness TEXT,
    subject TEXT NOT NULL, canonical_id TEXT, effort TEXT, raw REAL, normalized REAL, ref_min REAL, ref_max REAL,
    evaluated_at INTEGER, collected_at INTEGER NOT NULL, citation TEXT,
    UNIQUE (source, benchmark, version, harness, subject, effort)
  );
  CREATE TABLE scores (route_id TEXT NOT NULL, pool TEXT NOT NULL, p REAL, p_eff REAL, c REAL, l REAL, h REAL, r REAL,
    computed_at INTEGER NOT NULL, PRIMARY KEY (route_id, pool));
  CREATE TABLE rank_history (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, pool TEXT NOT NULL, session_hash TEXT,
    chosen_route TEXT, top4_json TEXT, reason TEXT);
  CREATE TABLE leases (job TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `,
  // v2: score explanation (indicators used, coverage, match, recency, independence)
  `ALTER TABLE scores ADD COLUMN detail_json TEXT;`,
  // v3: real-usage quality signals per assistant step (tool calls from OpenCode's part table)
  `ALTER TABLE request_metrics ADD COLUMN finish TEXT;
   ALTER TABLE request_metrics ADD COLUMN tool_calls INTEGER;
   ALTER TABLE request_metrics ADD COLUMN tool_schema_err INTEGER;
   ALTER TABLE request_metrics ADD COLUMN tool_other_err INTEGER;
   ALTER TABLE request_metrics ADD COLUMN edit_calls INTEGER;
   ALTER TABLE request_metrics ADD COLUMN edit_fail INTEGER;
   DELETE FROM request_metrics WHERE kind = 'selfeval';`,
  // v4: selector session state (one row per OpenCode session that uses an oamp/* marker model)
  `CREATE TABLE session_routes (
     session_hash TEXT PRIMARY KEY,
     pool         TEXT NOT NULL,
     auto         INTEGER NOT NULL DEFAULT 1,
     route_id     TEXT,
     better_since INTEGER,
     turns        INTEGER NOT NULL DEFAULT 0,
     parent_hash  TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   );
   CREATE INDEX session_routes_route ON session_routes(route_id, updated_at);
   CREATE INDEX request_metrics_session ON request_metrics(session_hash, ts);`,
]

export type Db = Database

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")
  migrate(db)
  return db
}

export function schemaVersion(db: Db): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)")
  const row = db.query("SELECT v FROM schema_version").get() as { v: number } | null
  return row?.v ?? 0
}

/**
 * Forward-only migrations. A DB newer than this code (after a rollback) is left untouched: every migration only adds
 * tables/columns, and queries name their columns, so older code keeps working on a newer schema.
 */
export function migrate(db: Db, migrations: string[] = MIGRATIONS): void {
  const tx = db.transaction(() => {
    const cur = schemaVersion(db)
    for (let v = cur; v < migrations.length; v++) db.exec(migrations[v]!)
    if (cur === 0) db.query("INSERT INTO schema_version (v) VALUES (?)").run(migrations.length)
    else if (cur < migrations.length) db.query("UPDATE schema_version SET v = ?").run(migrations.length)
  })
  tx.immediate()
}

/** Cross-process lease: true if `holder` now owns `job` until now+ttlMs. */
export function acquireLease(db: Db, job: string, holder: string, ttlMs: number, now = Date.now()): boolean {
  const res = db
    .query(
      `INSERT INTO leases (job, holder, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(job) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE leases.expires_at < ?4 OR leases.holder = excluded.holder`,
    )
    .run(job, holder, now + ttlMs, now)
  return res.changes > 0
}

export function releaseLease(db: Db, job: string, holder: string): void {
  db.query("DELETE FROM leases WHERE job = ? AND holder = ?").run(job, holder)
}

export function kvGet(db: Db, key: string): string | undefined {
  return (db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null)?.value
}

export function kvSet(db: Db, key: string, value: string, now = Date.now()): void {
  db.query("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, now)
}

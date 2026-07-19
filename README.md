# sealed-migrations

[![npm version](https://img.shields.io/npm/v/sealed-migrations.svg)](https://www.npmjs.com/package/sealed-migrations)
[![license](https://img.shields.io/npm/l/sealed-migrations.svg)](./LICENSE)

Checksum-tracked SQL migrations for MySQL and MariaDB with a **dev-first lifecycle**: a migration starts life unnumbered as `dev_<slug>/` and gets its number only right before merge (`seal`), so parallel branches never collide on migration numbers.

Zero runtime dependencies: you inject the database connection, so the package never bundles a driver.

## Why

The usual "number the migration when you write it" convention breaks with parallel branches: two feature branches both grab `042_*`, and the shared dev database ends up with a migration one branch has never seen, which most runners reject outright. `sealed-migrations` defers numbering to the last possible moment:

```text
create migrations/dev_add_timezone/    (you scaffold it; no number yet)
run "up"           -> applied to the dev DB as dev_add_timezone
  ... iterate freely (edit + down/up, or rehash) ...
run "seal add_timezone" -> renamed to migrations/043_add_timezone/, row updated
commit + merge
```

`up`, `down`, `seal`, `rehash`, `current`, and `status` are the commands. Creating the `dev_<slug>/` folder is not: `sealed-migrations` does not scaffold, so make the folder yourself (see [Creating a migration](#creating-a-migration)).

The number is picked as `max(numbered folders in the repo ∪ numbered versions on the dev DB) + 1`, so numbers already taken by other in-flight branches are skipped automatically. The checksum is content-only, so the rename does not invalidate it.

## Install

```bash
pnpm add sealed-migrations
# plus your driver, e.g.
pnpm add mysql2
```

## Quickstart

Write a thin wrapper that supplies the connection and any project-specific config. See [`examples/basic-wrapper.mjs`](./examples/basic-wrapper.mjs) and [`examples/mariadb-cluster-wrapper.mjs`](./examples/mariadb-cluster-wrapper.mjs).

```ts
import mysql from 'mysql2/promise'
import { createRunner } from 'sealed-migrations'

const runner = createRunner({
  migrationsDir: 'migrations',
  databaseName: process.env.DB_NAME,
  connect: () => mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  }),
})

// Programmatic:
await runner.up({ allowDev: true })
await runner.seal('add_timezone')

// Or drive it as a CLI (node wrapper.mjs up --allow-dev):
await runner.runCli(process.argv.slice(2))
```

Setting up in a new project? [SETUP.md](./SETUP.md) is the full first-time recipe (wrapper, scaffolder, baseline, branch guard, CI, deploy). Already have a vendored migration script? [MIGRATING.md](./MIGRATING.md) is a behaviour-preserving swap.

## Migration files

```text
migrations/
  001_baseline/          <- sealed, immutable once applied
    up.sql
    down.sql
  043_add_timezone/      <- sealed
    up.sql
    down.sql
  dev_new_feature/       <- unsealed dev migration (feature branch only)
    up.sql
    down.sql
```

- **Sealed**: `NNN_<slug>` (`/^(\d+)_([a-z0-9_]+)$/`). Immutable.
- **Dev**: `dev_<slug>` (`/^dev_([a-z0-9_]+)$/`). Unnumbered, mutable, sealed before merge.
- Sealed migrations apply in numeric order; dev migrations apply after all of them, alphabetically. Duplicate numeric prefixes stay deterministic via the folder-name tie-break.
- Both `up.sql` and `down.sql` are required and non-empty.
- Transaction mode is auto-detected (DDL runs non-transactional, since MySQL/MariaDB cannot roll back DDL) and can be forced with a first-line directive: `-- migrate: tx`, `-- migrate: no-tx`, or `-- migrate: auto`.
- Each applied migration stores `SHA-256(up.sql + "\n--down-sql--\n" + down.sql)`; a later edit to a sealed migration is refused.

## Creating a migration

`sealed-migrations` runs migrations; it does not scaffold them. Create the folder yourself, or add a tiny script to your wrapper:

```bash
slug="add_timezone"
mkdir -p "migrations/dev_${slug}"
printf -- '-- migrate: auto\n' > "migrations/dev_${slug}/up.sql"
printf -- '-- migrate: auto\n' > "migrations/dev_${slug}/down.sql"
```

Then fill in `up.sql` / `down.sql`, `up` to apply, and `seal ${slug}` right before merge.

## Commands

| Method | CLI | Purpose |
|---|---|---|
| `up({ to?, allowDev? })` | `up [--to=<v>] [--allow-dev]` | Apply pending migrations |
| `down({ to })` | `down --to=<v>` (or `--to=none`) | Roll back to a version |
| `seal(slug)` | `seal <slug>` | Assign the next number, rename, update the row |
| `rehash(slug)` | `rehash <slug>` | Realign the stored checksum after a manual schema change |
| `current()` | `current` | Print the highest applied version |
| `status()` | `status` | List all migrations; foreign dev rows show as `FOREIGN` |

`--to` accepts a unique prefix of a version (e.g. `--to=025` resolves to `025_order_confirmation_reminder`); an ambiguous prefix errors listing the candidates.

## Iterating on a dev migration

One feature keeps one migration. Two equivalent loops:

- **SQL-first** (the change should really run): edit `up.sql` / `down.sql`, then `down --to=<previous>` and `up`. `down` tolerates the checksum mismatch of an edited dev migration (warning only) and rolls back with the current `down.sql`.
- **DB-first** (you already changed the schema by hand): mirror the change into the files, then `rehash <slug>`. Nothing runs, only the stored checksum is realigned.

`up` and `status` stay strict on a mismatch and point you at both loops.

## Parallel branches

- An applied `dev_*` version missing from the current worktree (another branch's work) is a **warning only**; `up`, `status`, and `current` proceed, and `status` lists it as `FOREIGN`.
- An applied **numbered** version missing from the worktree is a hard error: merge or rebase first. Sealed history stays strict.

## The production guard

`up` refuses to run while any `dev_*` folder exists unless `allowDev` (`--allow-dev`) is set. Wire your local/CI paths to pass it and leave your production migrate path strict, so an unsealed migration that leaks into a release image fails the migrate step instead of applying. Pair it with a branch check (a pre-commit hook and a CI job) that blocks `dev_*` folders on your protected branches.

## Config reference

```ts
interface RunnerConfig {
  migrationsDir: string
  connect: () => Promise<MigrationConnection>
  lockName?: string // advisory GET_LOCK name (default sealed-migrations:lock)
  lockTimeoutSec?: number // default 120
  baselineVersion?: string // default 001_baseline
  databaseName?: string // enables the baseline short-circuit on an existing schema
  assertServer?: (conn) => Promise<void> // e.g. refuse a non-MariaDB server
  withRetry?: (fn, label) => Promise<T> // e.g. a Galera deadlock retry; default identity
  appVersion?: string | null // recorded in schema_migrations.app_version
  executedBy?: string | null // recorded in schema_migrations.executed_by
  logger?: { log, warn, error } // default console
}
```

### Connection injection

The runner needs only a small connection contract, satisfied by a `mysql2/promise` connection (and by test fakes):

```ts
interface MigrationConnection {
  query: <T>(sql: string) => Promise<[T, unknown]>
  execute: <T>(sql: string, params?: unknown[]) => Promise<[T, unknown]>
  beginTransaction: () => Promise<void>
  commit: () => Promise<void>
  rollback: () => Promise<void>
  end?: () => Promise<void>
}
```

Because the driver is yours, project-specific behaviour lives in config, not in a fork: a MySQL-locally / MariaDB-in-prod project supplies no `assertServer`, while a MariaDB-Galera project supplies both a MariaDB check and a deadlock `withRetry`.

## The `schema_migrations` table

Created automatically on first run:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version      VARCHAR(128) NOT NULL,
  description  VARCHAR(255) NOT NULL,
  checksum     CHAR(64)     NOT NULL,
  applied_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  execution_ms INT UNSIGNED NOT NULL,
  tx_mode      ENUM('transactional', 'non_transactional', 'baseline_mark') NOT NULL,
  app_version  VARCHAR(128) NULL,
  executed_by  VARCHAR(128) NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## License

[MIT](./LICENSE)

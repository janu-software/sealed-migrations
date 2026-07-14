# Adopting sealed-migrations in a project with a vendored runner

A copy-pasteable brief for moving a MySQL/MariaDB project that has its own vendored
migration script (`scripts/.../db-migrate.mjs` or similar) onto `sealed-migrations`,
**without changing behaviour**. Hand this file to an agent or follow it yourself.

## The idea

Replace the vendored runner with a **thin wrapper** that injects your project's
specifics as config. The engine (folder parsing, ordering, checksum, `seal`/`rehash`,
the `--allow-dev` guard, dev-migration tolerance) comes from the package. The wrapper
owns env resolution, the database connection, and the handful of knobs that differ
between projects. Anything project-specific becomes config, not a fork.

## Before you start

- Read your project's migration docs and conventions first.
- Never run destructive DB operations on real databases. Verify on a throwaway DB
  with a distinct name and a scratch `--migrations-dir`.

## Map your project

Fill these in from the vendored runner and your infra; they become the wrapper config:

| Knob | Where it comes from |
|---|---|
| `migrationsDir` | usually `migrations`, overridable via a flag/env |
| connection env names | your `DB_*` / `MYSQL_*` variables |
| `lockName` | your advisory-lock name (keep the existing one) |
| `databaseName` | your database-name env var (**required**, see gotchas) |
| `appVersion` / `executedBy` | CI SHA / hostname envs (**recommended**, metadata parity) |
| `assertServer` | supply only if you guard the server type (e.g. refuse non-MariaDB) |
| `withRetry` | supply only on a cluster that needs a deadlock retry (e.g. Galera, errno 1213/1205) |
| guard branch names | your protected branches (e.g. `main` + your deploy branch) |
| guard script path | your existing `check-dev-migrations.sh` location |
| test runner call site | where your tests spawn the runner (a test helper or global setup) |
| target DB engine(s) | e.g. MySQL locally and MariaDB in production |

Two common flavours, both shown in [`examples/`](./examples): a single-writer
MySQL-local / MariaDB-prod project (no `assertServer`, no `withRetry`), and a
MariaDB-on-a-cluster project (both hooks supplied).

## Steps

1. **Add the dependency** and pin it exactly: `pnpm add sealed-migrations@<latest published>`.
   `mysql2` and `dotenv` are almost certainly already present.
2. **Replace the vendored runner with a wrapper at the same path.** Keeping the path
   means `package.json` scripts, the deploy script, the container entrypoint, CI, and
   test helpers stay untouched. The wrapper:
   - loads env (dotenv, honouring your `--env-file` / env-file variable; tolerate a
     missing `.env` in containers),
   - reads the flags `runCli` does not (`--migrations-dir`, `--lock-name`,
     `--baseline-version`, `--lock-timeout-sec`) and folds them into config,
   - builds `createRunner(config)` with your project's knobs,
   - calls `runner.runCli(process.argv.slice(2))` and, on reject, `process.exit(1)`.

   Start from [`examples/basic-wrapper.mjs`](./examples/basic-wrapper.mjs) or
   [`examples/mariadb-cluster-wrapper.mjs`](./examples/mariadb-cluster-wrapper.mjs).
3. **Leave the glue unchanged:** the `new-migration.sh` scaffolder, the
   `check-dev-migrations.sh` branch guard, the CI guard job, the pre-commit hook, the
   migration docs, and the `package.json` `migrate:*` aliases. The package does not
   scaffold or gate branches; those stay in your repo. (Missing any of them?
   [SETUP.md](./SETUP.md) has copy-paste versions.)
4. **Dockerfile:** make sure the runtime / migrate image ships
   `node_modules/sealed-migrations` (the package has zero runtime deps but must be
   present, alongside `mysql2` / `dotenv`). Adjust the `COPY` lines if the image
   copies a pruned set of files instead of the whole `node_modules`.
5. **Tests:** delete the engine-level unit tests that tested the vendored runner
   directly (parsing, seal/rehash, guard) — that engine is now tested inside this
   package. Keep the integration tests that run the real wrapper against a real DB.

## Parity gotchas (do not skip)

- **Same wrapper path** as the vendored runner, so nothing downstream changes.
- **Set `databaseName`.** It gates the baseline short-circuit; omit it and the first
  production run executes the baseline SQL against an already-populated schema and fails.
- **Set `appVersion` and `executedBy`** to preserve `schema_migrations` metadata.
- **Production path stays strict:** the deploy/entrypoint call `up` without
  `--allow-dev`; only local dev, CI, and tests pass `--allow-dev`.
- The wrapper parses its own path/env flags; `runCli` handles the command, `--to`,
  `--allow-dev`, and the positional slug for `seal`/`rehash`.

## Verify (mandatory, on every DB engine you target)

On a throwaway DB (distinct name, scratch `--migrations-dir`), exercise the full
lifecycle and confirm it matches the pre-migration behaviour:

- `up` without `--allow-dev` refuses while a `dev_*` folder exists,
- apply order: numbered ascending then dev alphabetical (including a duplicate numeric
  prefix, if your history has one),
- an applied `dev_*` missing from the worktree warns and shows as `FOREIGN`,
- a checksum mismatch aborts `up`/`status`; `rehash` realigns it; `down` tolerates it,
- `seal` skips a number already claimed on the DB, renames the folder, updates the row,
- the SQL-first loop (edit, `down`, `up`) works,
- `seal <slug>` via the package.json alias forwards the slug.

Then run your project's DB integration suite (real migrations through the wrapper).
Do this against **each** engine you deploy to (e.g. MySQL and MariaDB). Never touch a
real dev database.

## Finish

Run your project's gates (lint, typecheck, tests) green, then commit following your
project's conventions.

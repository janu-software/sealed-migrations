#!/usr/bin/env node
// Example thin wrapper (e.g. scripts/db/db-migrate.mjs) for a project whose
// local dev runs MySQL and production runs MariaDB, on a single-writer setup.
//
// The wrapper owns everything project-specific (env var names, dotenv, the
// migrations dir, the lock name, CLI flags for path/env overrides). The engine
// owns the lifecycle. No assertServer and no withRetry are supplied, so the
// runner behaves like a plain single-writer migrator.
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import { createRunner } from 'sealed-migrations'

const argv = process.argv.slice(2)

// Parse the wrapper-owned flags (path/env), leave the rest to the runner.
function flag(name, fallbackEnv) {
  const eq = argv.find(a => a.startsWith(`--${name}=`))
  if (eq) {
    return eq.slice(name.length + 3)
  }
  return process.env[fallbackEnv ?? ''] ?? undefined
}

const envFile = flag('env-file', 'DB_ENV_FILE') ?? '.env'
dotenv.config({ path: path.resolve(process.cwd(), envFile), quiet: true })

const migrationsDir = flag('migrations-dir', 'DB_MIGRATIONS_DIR') ?? 'migrations'
const lockName = flag('lock-name', 'DB_MIGRATION_LOCK_NAME') ?? 'app:db:migrations'

const runner = createRunner({
  migrationsDir,
  lockName,
  databaseName: process.env.DB_NAME ?? process.env.MYSQL_DATABASE,
  appVersion: process.env.CI_COMMIT_SHA ?? process.env.npm_package_version ?? null,
  executedBy: process.env.NODE_HOSTNAME ?? process.env.HOSTNAME ?? null,
  connect: () => mysql.createConnection({
    host: process.env.DB_HOST ?? process.env.MYSQL_HOST ?? 'localhost',
    port: Number.parseInt(process.env.DB_PORT ?? process.env.MYSQL_PORT ?? '3306', 10),
    user: process.env.DB_USER ?? process.env.MYSQL_USER ?? 'root',
    password: process.env.DB_PASS ?? process.env.MYSQL_PASSWORD ?? '',
    database: process.env.DB_NAME ?? process.env.MYSQL_DATABASE,
    namedPlaceholders: true,
    dateStrings: true,
  }),
})

const executedAsCli = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false

if (executedAsCli) {
  runner.runCli(argv).catch((error) => {
    console.error(error?.stack ?? error?.message ?? error)
    process.exit(1)
  })
}

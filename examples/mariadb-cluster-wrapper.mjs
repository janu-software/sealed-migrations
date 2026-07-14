#!/usr/bin/env node
// Example thin wrapper for a project on MariaDB everywhere, running on a
// Galera cluster. Same engine, two extra config hooks:
//   - assertServer refuses to run against a non-MariaDB server (a common
//     "connected to the wrong port" foot-gun),
//   - withRetry retries the schema_migrations write on a Galera deadlock
//     (ER_LOCK_DEADLOCK / ER_LOCK_WAIT_TIMEOUT), which can surface even for a
//     single writer right after a DDL statement.
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import { createRunner } from 'sealed-migrations'

dotenv.config({ path: path.resolve(process.cwd(), process.env.DB_ENV_FILE ?? '.env'), quiet: true })

const RETRYABLE = new Set([1213, 1205]) // ER_LOCK_DEADLOCK, ER_LOCK_WAIT_TIMEOUT

async function withRetry(fn, label, maxAttempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    }
    catch (error) {
      if (!RETRYABLE.has(error?.errno) || attempt >= maxAttempts) {
        throw error
      }
      const backoffMs = Math.min(2000, 100 * 2 ** (attempt - 1))
      console.warn(`${label}: retryable lock error ${error.errno} (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs}ms`)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
    }
  }
}

async function assertMariaDB(conn) {
  const [rows] = await conn.query('SELECT VERSION() AS v')
  const version = String(rows?.[0]?.v ?? '')
  if (!/MariaDB/i.test(version)) {
    throw new Error(`Refusing to run migrations: server reports "${version}", which is not MariaDB.`)
  }
}

const runner = createRunner({
  migrationsDir: process.env.DB_MIGRATIONS_DIR ?? 'migrations',
  lockName: process.env.DB_MIGRATION_LOCK_NAME ?? 'app:db:migrations',
  databaseName: process.env.MYSQL_DATABASE,
  appVersion: process.env.CI_COMMIT_SHA ?? null,
  executedBy: process.env.HOSTNAME ?? null,
  assertServer: assertMariaDB,
  withRetry,
  connect: () => mysql.createConnection({
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number.parseInt(process.env.MYSQL_PORT ?? '3306', 10),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE,
  }),
})

const executedAsCli = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false

if (executedAsCli) {
  runner.runCli(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? error?.message ?? error)
    process.exit(1)
  })
}

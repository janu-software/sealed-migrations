import type { AppliedMap, Logger, Migration, MigrationConnection, RunnerConfig, TxMode, ValidateOptions } from './types'
import { isDevVersion } from './migrations'

interface AppliedRow {
  version: string
  checksum: string
  applied_at?: unknown
}

export async function ensureSchemaMigrationsTable(conn: MigrationConnection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) NOT NULL,
      description VARCHAR(255) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      execution_ms INT UNSIGNED NOT NULL,
      tx_mode ENUM('transactional', 'non_transactional', 'baseline_mark') NOT NULL,
      app_version VARCHAR(128) NULL,
      executed_by VARCHAR(128) NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

export async function getAppliedMigrations(conn: MigrationConnection): Promise<AppliedMap> {
  const [rows] = await conn.query<AppliedRow[]>(
    `SELECT version, checksum, applied_at FROM schema_migrations ORDER BY applied_at ASC, version ASC`,
  )

  const byVersion: AppliedMap = new Map()
  for (const row of rows) {
    byVersion.set(row.version, {
      checksum: row.checksum,
      appliedAt: row.applied_at,
    })
  }

  return byVersion
}

export async function getSchemaHasUserTables(conn: MigrationConnection, dbName: string): Promise<boolean> {
  const [rows] = await conn.execute<Array<{ cnt: number }>>(
    `
      SELECT COUNT(*) AS cnt
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migrations'
    `,
    [dbName],
  )

  return Number(rows[0]?.cnt ?? 0) > 0
}

export async function acquireLock(conn: MigrationConnection, lockName: string, timeoutSec: number): Promise<void> {
  const [rows] = await conn.execute<Array<{ lock_acquired: number }>>('SELECT GET_LOCK(?, ?) AS lock_acquired', [lockName, timeoutSec])
  const value = Number(rows[0]?.lock_acquired)

  if (value !== 1) {
    throw new Error(`Failed to acquire migration lock "${lockName}" within ${timeoutSec}s`)
  }
}

export async function releaseLock(conn: MigrationConnection, lockName: string): Promise<void> {
  try {
    await conn.execute('SELECT RELEASE_LOCK(?)', [lockName])
  }
  catch {
    // Do not mask the original migration error.
  }
}

export async function insertAppliedMigration(
  conn: MigrationConnection,
  migration: Pick<Migration, 'version' | 'description' | 'checksum'>,
  txMode: TxMode,
  executionMs: number,
  config: Pick<RunnerConfig, 'appVersion' | 'executedBy'>,
): Promise<void> {
  // `ON DUPLICATE KEY UPDATE version = version` is a no-op that makes the insert
  // idempotent: if a retry re-runs after a deadlock that actually landed the
  // row, the second attempt does not fail with a duplicate key.
  await conn.execute(
    `
      INSERT INTO schema_migrations
        (version, description, checksum, execution_ms, tx_mode, app_version, executed_by)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE version = version
    `,
    [
      migration.version,
      migration.description,
      migration.checksum,
      executionMs,
      txMode,
      config.appVersion ?? null,
      config.executedBy ?? null,
    ],
  )
}

export async function deleteAppliedMigration(conn: MigrationConnection, version: string): Promise<void> {
  await conn.execute('DELETE FROM schema_migrations WHERE version = ?', [version])
}

function makeMigrationMap(migrations: Migration[]): Map<string, Migration> {
  return new Map(migrations.map(migration => [migration.version, migration]))
}

/**
 * Checks applied state against the repo:
 * - a dev migration applied elsewhere but missing here is only a warning
 *   (the normal state of a shared dev DB with parallel branches),
 * - a numbered migration missing here is a hard error (sealed history is strict),
 * - a checksum mismatch is a hard error, except a dev mismatch in `warn` mode
 *   (the `down` path, so the SQL-first edit loop can start).
 */
export function validateAppliedState(
  migrations: Migration[],
  appliedByVersion: AppliedMap,
  options: ValidateOptions = {},
  logger: Logger = console,
): void {
  const devChecksumMismatch = options.devChecksumMismatch ?? 'error'
  const migrationsByVersion = makeMigrationMap(migrations)

  for (const [version] of appliedByVersion) {
    if (migrationsByVersion.has(version)) {
      continue
    }

    if (isDevVersion(version)) {
      logger.warn(`WARNING: applied dev migration ${version} is missing in this worktree (parallel branch), skipping`)
      continue
    }

    throw new Error(`Applied migration ${version} is missing in repository`)
  }

  for (const migration of migrations) {
    const applied = appliedByVersion.get(migration.version)
    if (!applied) {
      continue
    }

    if (applied.checksum !== migration.checksum) {
      if (migration.isDev) {
        if (devChecksumMismatch === 'warn') {
          logger.warn(
            `WARNING: checksum mismatch for dev migration ${migration.version} (files changed since apply), continuing with the current SQL`,
          )
          continue
        }
        const slug = migration.version.slice('dev_'.length)
        throw new Error(
          `Checksum mismatch for dev migration ${migration.version}. `
          + `Re-apply it (down + up), or run "seal|rehash ${slug}" `
          + `if you already applied the schema change manually.`,
        )
      }
      throw new Error(`Checksum mismatch for migration ${migration.version}. Applied migration files were modified.`)
    }
  }
}

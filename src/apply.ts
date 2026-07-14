import type { Logger, Migration, MigrationConnection, RunnerConfig, TxMode } from './types'
import { resolveTxMode, splitSqlStatements, stripLeadingComments } from './sql'
import { deleteAppliedMigration, insertAppliedMigration } from './state'

/** Identity wrapper used when the consumer does not supply a retry strategy. */
export function passthroughRetry<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}

async function executeStatements(conn: MigrationConnection, statements: string[], context: string): Promise<void> {
  for (let i = 0; i < statements.length; i += 1) {
    const executableSql = stripLeadingComments(statements[i] ?? '').trim()
    if (!executableSql) {
      continue
    }

    try {
      await conn.query(executableSql)
    }
    catch (error) {
      const err = error as { sqlMessage?: string, message?: string }
      const message = err?.sqlMessage ?? err?.message ?? 'Unknown SQL error'
      throw new Error(`${context} failed at statement #${i + 1}: ${message}`, { cause: error })
    }
  }
}

type ApplyConfig = Pick<RunnerConfig, 'appVersion' | 'executedBy' | 'withRetry'>

export async function applyUpMigration(
  conn: MigrationConnection,
  migration: Migration,
  config: ApplyConfig,
  logger: Logger,
): Promise<void> {
  const statements = splitSqlStatements(migration.upSql)
  if (statements.length === 0) {
    throw new Error(`Migration ${migration.version} has empty up.sql`)
  }

  const withRetry = config.withRetry ?? passthroughRetry
  const txMode = resolveTxMode(migration.upSql, statements)
  const start = Date.now()

  if (txMode === 'transactional') {
    // No DDL: begin/execute/record/commit is retryable as a unit, since the
    // rollback leaves no side effects to clean up.
    await withRetry(async () => {
      await conn.beginTransaction()
      try {
        await executeStatements(conn, statements, `UP migration ${migration.version}`)
        await insertAppliedMigration(conn, migration, txMode, Date.now() - start, config)
        await conn.commit()
      }
      catch (error) {
        await conn.rollback()
        throw error
      }
    }, `UP migration ${migration.version}`)
  }
  else {
    // DDL auto-commits and cannot be re-run, so only the record write is
    // retried: on a cluster that is the statement that can deadlock right after
    // a DDL and otherwise leaves the migration applied but unrecorded.
    await executeStatements(conn, statements, `UP migration ${migration.version}`)
    await withRetry(
      () => insertAppliedMigration(conn, migration, txMode, Date.now() - start, config),
      `record migration ${migration.version}`,
    )
  }

  logger.log(`Applied ${migration.version}`)
}

export async function markBaselineAsApplied(
  conn: MigrationConnection,
  migration: Migration,
  config: ApplyConfig,
  logger: Logger,
): Promise<void> {
  await insertAppliedMigration(conn, migration, 'baseline_mark' satisfies TxMode, 0, config)
  logger.log(`Baseline ${migration.version} marked as applied (existing schema detected)`)
}

export async function applyDownMigration(conn: MigrationConnection, migration: Migration, logger: Logger): Promise<void> {
  const statements = splitSqlStatements(migration.downSql)
  if (statements.length === 0) {
    throw new Error(`Migration ${migration.version} has empty down.sql`)
  }

  const txMode = resolveTxMode(migration.downSql, statements)

  if (txMode === 'transactional') {
    await conn.beginTransaction()
    try {
      await executeStatements(conn, statements, `DOWN migration ${migration.version}`)
      await deleteAppliedMigration(conn, migration.version)
      await conn.commit()
    }
    catch (error) {
      await conn.rollback()
      throw error
    }
  }
  else {
    await executeStatements(conn, statements, `DOWN migration ${migration.version}`)
    await deleteAppliedMigration(conn, migration.version)
  }

  logger.log(`Rolled back ${migration.version}`)
}

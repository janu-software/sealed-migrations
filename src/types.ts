/**
 * The subset of a database connection the runner needs. A `mysql2/promise`
 * Connection satisfies it structurally (so a consumer can pass
 * `mysql.createConnection(...)` with no cast), and so does any compatible
 * driver or test fake. The consumer owns the driver, so this package has no
 * runtime dependency on mysql2 (or any specific client).
 *
 * `params` and the row tuples are intentionally loose: this is the untyped
 * driver boundary, and a stricter shape would reject real driver types through
 * parameter contravariance. Callers narrow rows internally.
 */
export interface MigrationConnection {
  query: <T = any>(sql: string) => Promise<[T, any]>
  execute: <T = any>(sql: string, params?: any) => Promise<[T, any]>
  beginTransaction: () => Promise<void>
  commit: () => Promise<void>
  rollback: () => Promise<void>
  end?: () => Promise<void>
}

export type Logger = Pick<Console, 'log' | 'warn' | 'error'>

export interface RunnerConfig {
  /** Path to the migrations directory (absolute, or relative to `process.cwd()`). */
  migrationsDir: string
  /** Opens a connection the runner owns and closes for a single command. */
  connect: () => Promise<MigrationConnection>
  /** MySQL advisory lock name serialising up/down/seal/rehash. */
  lockName?: string
  /** Seconds to wait for the advisory lock (default 120). */
  lockTimeoutSec?: number
  /** Version treated as the baseline (default `001_baseline`). */
  baselineVersion?: string
  /**
   * Database name, used only to detect an existing schema for the baseline
   * short-circuit. Omit to always execute the baseline SQL.
   */
  databaseName?: string
  /** Optional pre-flight assertion, e.g. refuse a non-MariaDB server. */
  assertServer?: (conn: MigrationConnection) => Promise<void>
  /**
   * Wraps retryable writes, e.g. a Galera deadlock retry. Defaults to a plain
   * pass-through, so a single-writer setup needs no configuration.
   */
  withRetry?: <T>(fn: () => Promise<T>, label: string) => Promise<T>
  /** Recorded in `schema_migrations.app_version`. */
  appVersion?: string | null
  /** Recorded in `schema_migrations.executed_by`. */
  executedBy?: string | null
  /** Sink for progress messages (default `console`). */
  logger?: Logger
}

export type TxMode = 'transactional' | 'non_transactional' | 'baseline_mark'

export interface ParsedMigrationName {
  isDev: boolean
  sortNumber: number
  version: string
  description: string
}

export interface Migration extends ParsedMigrationName {
  upSql: string
  downSql: string
  checksum: string
}

export interface AppliedMigration {
  checksum: string
  appliedAt?: unknown
}

export type AppliedMap = Map<string, AppliedMigration>

export interface ValidateOptions {
  /** How a checksum mismatch on an applied dev migration is handled. */
  devChecksumMismatch?: 'error' | 'warn'
}

export interface UpOptions {
  to?: string
  allowDev?: boolean
}

export interface DownOptions {
  to?: string
}

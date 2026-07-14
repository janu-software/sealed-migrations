import type { DownOptions, Logger, Migration, MigrationConnection, RunnerConfig, UpOptions } from './types'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { applyDownMigration, applyUpMigration, markBaselineAsApplied } from './apply'
import { fileExists, isDevVersion, MIGRATION_DIR_PATTERN, normalizeDevVersion } from './migrations'
import { getAppliedMigrations, getSchemaHasUserTables, validateAppliedState } from './state'

const DEFAULT_BASELINE_VERSION = '001_baseline'

export function assertDevMigrationsAllowed(migrations: Migration[], allowDev: boolean): void {
  if (allowDev) {
    return
  }

  const devVersions = migrations.filter(migration => migration.isDev).map(migration => migration.version)
  if (devVersions.length === 0) {
    return
  }

  throw new Error(
    `Refusing to run "up" with unsealed dev migrations present: ${devVersions.join(', ')}. `
    + `Only sealed (numbered) migrations may reach production. Seal them first. `
    + `For local development pass allowDev / --allow-dev.`,
  )
}

/** Next free number = max(numbered repo folders ∪ numbered applied versions) + 1. */
export function computeNextSealNumber(migrations: Migration[], appliedVersions: string[]): string {
  let max = 0

  for (const migration of migrations) {
    if (!migration.isDev && migration.sortNumber > max) {
      max = migration.sortNumber
    }
  }

  // Numbers applied on the dev DB but missing from this worktree belong to
  // other in-flight branches; their numbers are taken too.
  for (const version of appliedVersions) {
    const match = MIGRATION_DIR_PATTERN.exec(version)
    if (match) {
      const value = Number.parseInt(match[1] ?? '0', 10)
      if (value > max) {
        max = value
      }
    }
  }

  return String(max + 1).padStart(3, '0')
}

export async function commandCurrent(conn: MigrationConnection, migrations: Migration[], logger: Logger): Promise<void> {
  const applied = await getAppliedMigrations(conn)
  validateAppliedState(migrations, applied, {}, logger)

  const latestApplied = [...migrations].reverse().find(migration => applied.has(migration.version))
  logger.log(latestApplied?.version ?? 'none')
}

export async function commandStatus(conn: MigrationConnection, migrations: Migration[], logger: Logger): Promise<void> {
  const applied = await getAppliedMigrations(conn)
  validateAppliedState(migrations, applied, {}, logger)

  for (const migration of migrations) {
    const status = applied.has(migration.version) ? 'APPLIED' : 'PENDING'
    logger.log(`${status.padEnd(8, ' ')} ${migration.version}  ${migration.description}`)
  }

  const repoVersions = new Set(migrations.map(migration => migration.version))
  for (const [version] of applied) {
    if (!repoVersions.has(version) && isDevVersion(version)) {
      logger.log(`FOREIGN  ${version}  (applied on this DB, missing in this worktree)`)
    }
  }
}

export async function commandUp(
  conn: MigrationConnection,
  migrations: Migration[],
  config: RunnerConfig,
  options: UpOptions,
  logger: Logger,
): Promise<void> {
  if (migrations.length === 0) {
    logger.log('No migrations found')
    return
  }

  const baselineVersion = config.baselineVersion ?? DEFAULT_BASELINE_VERSION
  if (baselineVersion && migrations[0]?.version !== baselineVersion) {
    throw new Error(`Baseline migration must be the first migration (${baselineVersion})`)
  }

  const targetVersion = (options.to ?? '').trim()
  const targetIndex = targetVersion
    ? migrations.findIndex(migration => migration.version === targetVersion)
    : migrations.length - 1

  if (targetVersion && targetIndex < 0) {
    throw new Error(`Target version not found: ${targetVersion}`)
  }

  const applied = await getAppliedMigrations(conn)
  validateAppliedState(migrations, applied, {}, logger)

  for (let index = 0; index <= targetIndex; index += 1) {
    const migration = migrations[index]
    if (!migration || applied.has(migration.version)) {
      continue
    }

    if (migration.version === baselineVersion) {
      if (applied.size > 0) {
        throw new Error('Baseline migration is pending but newer migrations are already applied. State is inconsistent.')
      }

      if (config.databaseName) {
        const hasUserTables = await getSchemaHasUserTables(conn, config.databaseName)
        if (hasUserTables) {
          await markBaselineAsApplied(conn, migration, config, logger)
          applied.set(migration.version, { checksum: migration.checksum })
          continue
        }
      }
    }

    await applyUpMigration(conn, migration, config, logger)
    applied.set(migration.version, { checksum: migration.checksum })
  }

  const latestApplied = [...migrations].reverse().find(migration => applied.has(migration.version))
  logger.log(`Current DB version: ${latestApplied?.version ?? 'none'}`)
}

export async function commandDown(
  conn: MigrationConnection,
  migrations: Migration[],
  options: DownOptions,
  logger: Logger,
): Promise<void> {
  const targetVersion = (options.to ?? '').trim()
  if (!targetVersion) {
    throw new Error('Rollback requires a target version (to / --to=<version>)')
  }

  const applied = await getAppliedMigrations(conn)
  // `down` tolerates an edited dev migration so the SQL-first loop can start.
  validateAppliedState(migrations, applied, { devChecksumMismatch: 'warn' }, logger)

  if (targetVersion !== 'none' && !applied.has(targetVersion)) {
    throw new Error(`Target version ${targetVersion} is not currently applied`)
  }

  const targetIndex = targetVersion === 'none'
    ? -1
    : migrations.findIndex(migration => migration.version === targetVersion)

  if (targetVersion !== 'none' && targetIndex < 0) {
    throw new Error(`Target version not found in repository: ${targetVersion}`)
  }

  const rollbackList = migrations
    .filter((migration, index) => index > targetIndex && applied.has(migration.version))
    .reverse()

  if (rollbackList.length === 0) {
    logger.log(`Nothing to rollback. Current DB already at ${targetVersion}`)
    return
  }

  for (const migration of rollbackList) {
    await applyDownMigration(conn, migration, logger)
  }

  logger.log(`Rollback complete. Target DB version: ${targetVersion}`)
}

export async function commandSeal(
  conn: MigrationConnection,
  migrations: Migration[],
  migrationsDir: string,
  slug: string | undefined,
  logger: Logger,
): Promise<void> {
  const devVersion = normalizeDevVersion(slug)
  const migration = migrations.find(candidate => candidate.version === devVersion)
  if (!migration) {
    throw new Error(`Dev migration not found: ${path.join(migrationsDir, devVersion)}`)
  }

  const applied = await getAppliedMigrations(conn)
  const appliedRow = applied.get(devVersion)
  const bareSlug = devVersion.slice('dev_'.length)

  if (appliedRow && appliedRow.checksum !== migration.checksum) {
    throw new Error(
      `Checksum mismatch for ${devVersion}: the files differ from what was applied. `
      + `Re-apply it (down + up) or rehash ${bareSlug} first.`,
    )
  }

  const nextNumber = computeNextSealNumber(migrations, [...applied.keys()])
  const sealedVersion = `${nextNumber}_${bareSlug}`
  const devDir = path.join(migrationsDir, devVersion)
  const sealedDir = path.join(migrationsDir, sealedVersion)

  if (await fileExists(sealedDir)) {
    throw new Error(`Cannot seal ${devVersion}: target directory already exists: ${sealedDir}`)
  }

  if (!appliedRow) {
    await fs.rename(devDir, sealedDir)
    logger.log(`Sealed ${devVersion} as ${sealedVersion} (not applied on this DB, folder renamed only)`)
    logger.log('Commit the renamed folder before merging.')
    return
  }

  // DB row first, folder second: the reverse order would leave a window where
  // the sealed folder looks pending and the runner re-applies its SQL.
  await conn.execute(
    'UPDATE schema_migrations SET version = ?, description = ? WHERE version = ?',
    [sealedVersion, migration.description, devVersion],
  )

  try {
    await fs.rename(devDir, sealedDir)
  }
  catch (renameError) {
    const rename = renameError as { message?: string }
    try {
      await conn.execute(
        'UPDATE schema_migrations SET version = ?, description = ? WHERE version = ?',
        [devVersion, migration.description, sealedVersion],
      )
    }
    catch (revertError) {
      const revert = revertError as { message?: string }
      throw new Error(
        `Failed to rename ${devDir} to ${sealedDir} (${rename?.message}) AND failed to revert schema_migrations `
        + `(${revert?.message}). Fix manually: UPDATE schema_migrations SET version = '${devVersion}' WHERE version = '${sealedVersion}'`,
        { cause: revertError },
      )
    }
    throw new Error(
      `Failed to rename ${devDir} to ${sealedDir}: ${rename?.message}. schema_migrations was reverted to ${devVersion}.`,
      { cause: renameError },
    )
  }

  logger.log(`Sealed ${devVersion} as ${sealedVersion} (schema_migrations updated)`)
  logger.log('Commit the renamed folder before merging.')
}

export async function commandRehash(
  conn: MigrationConnection,
  migrations: Migration[],
  slug: string | undefined,
  logger: Logger,
): Promise<void> {
  const devVersion = normalizeDevVersion(slug)
  const migration = migrations.find(candidate => candidate.version === devVersion)
  if (!migration) {
    throw new Error(`Dev migration not found in repository: ${devVersion}`)
  }

  const [rows] = await conn.execute<Array<{ version: string, checksum: string }>>(
    'SELECT version, checksum FROM schema_migrations WHERE version = ?',
    [devVersion],
  )

  if (!rows || rows.length === 0) {
    throw new Error(
      `Dev migration ${devVersion} is not applied on this database. Nothing to rehash, run "up" instead.`,
    )
  }

  if (rows[0]?.checksum === migration.checksum) {
    logger.log(`Checksum for ${devVersion} is already up to date`)
    return
  }

  await conn.execute(
    'UPDATE schema_migrations SET checksum = ? WHERE version = ?',
    [migration.checksum, devVersion],
  )
  logger.log(`Updated checksum for ${devVersion} to match the current up.sql + down.sql content`)
}

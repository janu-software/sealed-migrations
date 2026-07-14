import type { Migration, ParsedMigrationName } from './types'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const MIGRATION_DIR_PATTERN = /^(\d+)_([a-z0-9_]+)$/
export const DEV_MIGRATION_DIR_PATTERN = /^dev_([a-z0-9_]+)$/

/** SHA-256 of `up.sql + "\n--down-sql--\n" + down.sql`, content only. */
export function hashMigration(upSql: string, downSql: string): string {
  return createHash('sha256').update(upSql).update('\n--down-sql--\n').update(downSql).digest('hex')
}

export function isDevVersion(version: string): boolean {
  return DEV_MIGRATION_DIR_PATTERN.test(String(version))
}

export function parseMigrationDirName(dirName: string): ParsedMigrationName {
  const devMatch = DEV_MIGRATION_DIR_PATTERN.exec(dirName)
  if (devMatch) {
    // Dev migrations sort after every numbered migration; ties between dev
    // migrations resolve alphabetically in the shared sort below.
    return {
      isDev: true,
      sortNumber: Number.POSITIVE_INFINITY,
      version: dirName,
      description: (devMatch[1] ?? '').replaceAll('_', ' '),
    }
  }

  const match = MIGRATION_DIR_PATTERN.exec(dirName)
  if (!match) {
    throw new Error(
      `Invalid migration directory name "${dirName}". Expected format: NNN_description (example: 002_add_column_x) or dev_description (example: dev_add_column_x)`,
    )
  }

  return {
    isDev: false,
    sortNumber: Number.parseInt(match[1] ?? '0', 10),
    version: dirName,
    description: (match[2] ?? '').replaceAll('_', ' '),
  }
}

/**
 * Normalises a `seal`/`rehash` argument into a `dev_<slug>` version. Accepts
 * both `foo` and `dev_foo`, and refuses sealed (numbered) versions, which are
 * immutable.
 */
export function normalizeDevVersion(input: string | undefined): string {
  const raw = (input ?? '').trim()
  if (!raw) {
    throw new Error('Missing dev migration slug. Usage: seal|rehash <slug> (slug or dev_<slug>)')
  }

  if (MIGRATION_DIR_PATTERN.test(raw)) {
    throw new Error(`${raw} is a sealed (numbered) migration. Sealed migrations are immutable; this command only operates on dev migrations.`)
  }

  const version = raw.startsWith('dev_') ? raw : `dev_${raw}`
  if (!DEV_MIGRATION_DIR_PATTERN.test(version)) {
    throw new Error(`Invalid dev migration slug "${raw}". Expected [a-z0-9_]+ (example: album_sharing)`)
  }

  return version
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  }
  catch {
    return false
  }
}

/**
 * Reads every migration folder, sorted numbered-ascending then dev
 * alphabetical. Duplicate numeric prefixes stay deterministic via the folder
 * name tie-break.
 */
export async function readMigrations(migrationsDir: string): Promise<Migration[]> {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true })
  const dirs = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => {
      const left = parseMigrationDirName(a)
      const right = parseMigrationDirName(b)
      if (left.sortNumber !== right.sortNumber) {
        return left.sortNumber - right.sortNumber
      }
      return left.version.localeCompare(right.version)
    })

  const migrations: Migration[] = []

  for (const dirName of dirs) {
    const parsed = parseMigrationDirName(dirName)
    const migrationPath = path.join(migrationsDir, dirName)
    const upPath = path.join(migrationPath, 'up.sql')
    const downPath = path.join(migrationPath, 'down.sql')

    const [upExists, downExists] = await Promise.all([
      fileExists(upPath),
      fileExists(downPath),
    ])

    if (!upExists || !downExists) {
      throw new Error(`Migration ${dirName} must contain up.sql and down.sql`)
    }

    const [upSql, downSql] = await Promise.all([
      fs.readFile(upPath, 'utf8'),
      fs.readFile(downPath, 'utf8'),
    ])

    migrations.push({
      ...parsed,
      upSql,
      downSql,
      checksum: hashMigration(upSql, downSql),
    })
  }

  return migrations
}

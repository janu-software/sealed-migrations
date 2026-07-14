import type { Migration, MigrationConnection } from '../src'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertDevMigrationsAllowed,
  commandDown,
  commandRehash,
  commandSeal,
  hashMigration,
  readMigrations,
} from '../src'

// A test fake cannot satisfy the generic MigrationConnection query/execute
// overloads, so cast through unknown; the mock handles stay typed for asserts.
function asConn(value: object): MigrationConnection {
  return value as unknown as MigrationConnection
}

async function makeMigrationDir(root: string, name: string, upSql = 'SELECT 1;', downSql = 'SELECT 1;'): Promise<string> {
  const dir = path.join(root, name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'up.sql'), upSql)
  await fsp.writeFile(path.join(dir, 'down.sql'), downSql)
  return dir
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sealed-migrations-cmd-'))
})

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function fakeConn(appliedRows: Array<{ version: string, checksum: string, applied_at?: string }>) {
  const execute = vi.fn(async () => [{}, []])
  const conn = {
    query: vi.fn(async () => [appliedRows, []]),
    execute,
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
  }
  return { conn: asConn(conn), execute }
}

describe('assertDevMigrationsAllowed', () => {
  const withDev = [
    { isDev: false, sortNumber: 1, version: '001_baseline' },
    { isDev: true, sortNumber: Number.POSITIVE_INFINITY, version: 'dev_album' },
  ] as Migration[]

  it('refuses dev migrations without the allow flag', () => {
    expect(() => assertDevMigrationsAllowed(withDev, false)).toThrow(/dev_album/)
  })

  it('passes with the allow flag', () => {
    expect(() => assertDevMigrationsAllowed(withDev, true)).not.toThrow()
  })

  it('passes without dev migrations', () => {
    expect(() => assertDevMigrationsAllowed([withDev[0]!], false)).not.toThrow()
  })
})

describe('commandSeal', () => {
  it('renames the folder, updates schema_migrations and keeps the checksum valid', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, '002_second')
    const upSql = 'CREATE TABLE IF NOT EXISTS t (id INT);'
    const downSql = 'DROP TABLE IF EXISTS t;'
    await makeMigrationDir(tmpRoot, 'dev_album_share', upSql, downSql)

    const migrations = await readMigrations(tmpRoot)
    const devChecksum = hashMigration(upSql, downSql)
    // 003_other_branch is applied on the dev DB but missing here: seal must
    // tolerate it AND skip past its number.
    const { conn, execute } = fakeConn([
      { version: '001_baseline', checksum: migrations[0]!.checksum },
      { version: '003_other_branch', checksum: 'xxx' },
      { version: 'dev_album_share', checksum: devChecksum },
    ])

    await commandSeal(conn, migrations, tmpRoot, 'album_share', console)

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE schema_migrations SET version'),
      ['004_album_share', 'album share', 'dev_album_share'],
    )
    await expect(fsp.access(path.join(tmpRoot, '004_album_share', 'up.sql'))).resolves.toBeUndefined()
    await expect(fsp.access(path.join(tmpRoot, 'dev_album_share'))).rejects.toThrow()

    const resealed = await readMigrations(tmpRoot)
    expect(resealed.find(m => m.version === '004_album_share')?.checksum).toBe(devChecksum)
  })

  it('only renames when the dev migration is not applied', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, 'dev_album_share')
    const migrations = await readMigrations(tmpRoot)
    const { conn, execute } = fakeConn([{ version: '001_baseline', checksum: migrations[0]!.checksum }])

    await commandSeal(conn, migrations, tmpRoot, 'album_share', console)

    expect(execute).not.toHaveBeenCalled()
    await expect(fsp.access(path.join(tmpRoot, '002_album_share'))).resolves.toBeUndefined()
  })

  it('refuses to seal when the applied checksum differs from the files', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, 'dev_album_share')
    const migrations = await readMigrations(tmpRoot)
    const { conn, execute } = fakeConn([{ version: 'dev_album_share', checksum: 'STALE' }])

    await expect(commandSeal(conn, migrations, tmpRoot, 'album_share', console)).rejects.toThrow(/rehash album_share/)
    expect(execute).not.toHaveBeenCalled()
    await expect(fsp.access(path.join(tmpRoot, 'dev_album_share'))).resolves.toBeUndefined()
  })

  it('reverts the schema_migrations update when the folder rename fails', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    const upSql = 'SELECT 1;'
    const downSql = 'SELECT 2;'
    await makeMigrationDir(tmpRoot, 'dev_album_share', upSql, downSql)
    const migrations = await readMigrations(tmpRoot)
    const { conn, execute } = fakeConn([{ version: 'dev_album_share', checksum: hashMigration(upSql, downSql) }])

    const renameSpy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('disk says no'))

    await expect(commandSeal(conn, migrations, tmpRoot, 'album_share', console)).rejects.toThrow(/reverted/)
    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('UPDATE schema_migrations SET version'),
      ['002_album_share', 'album share', 'dev_album_share'],
    )
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE schema_migrations SET version'),
      ['dev_album_share', 'album share', '002_album_share'],
    )
  })

  it('fails when the dev migration folder does not exist', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    const migrations = await readMigrations(tmpRoot)
    await expect(commandSeal(fakeConn([]).conn, migrations, tmpRoot, 'ghost', console)).rejects.toThrow(/Dev migration not found/)
  })
})

describe('commandRehash', () => {
  function rehashConn(selectRows: Array<{ version: string, checksum: string }>) {
    const execute = vi.fn(async (sql: string) => {
      if (sql.trim().startsWith('SELECT')) {
        return [selectRows, []]
      }
      return [{}, []]
    })
    const conn = { query: vi.fn(async () => [[], []]), execute, beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) }
    return { conn: asConn(conn), execute }
  }

  it('updates the stored checksum to the current file content', async () => {
    const upSql = 'ALTER TABLE t ADD COLUMN c INT;'
    const downSql = 'ALTER TABLE t DROP COLUMN c;'
    await makeMigrationDir(tmpRoot, 'dev_album_share', upSql, downSql)
    const migrations = await readMigrations(tmpRoot)
    const { conn, execute } = rehashConn([{ version: 'dev_album_share', checksum: 'OLD' }])

    await commandRehash(conn, migrations, 'album_share', console)

    expect(execute).toHaveBeenCalledWith(
      'UPDATE schema_migrations SET checksum = ? WHERE version = ?',
      [hashMigration(upSql, downSql), 'dev_album_share'],
    )
  })

  it('is a no-op when the checksum already matches', async () => {
    const upSql = 'SELECT 1;'
    const downSql = 'SELECT 2;'
    await makeMigrationDir(tmpRoot, 'dev_album_share', upSql, downSql)
    const migrations = await readMigrations(tmpRoot)
    const { conn, execute } = rehashConn([{ version: 'dev_album_share', checksum: hashMigration(upSql, downSql) }])

    await commandRehash(conn, migrations, 'album_share', console)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('fails when the dev migration is not applied', async () => {
    await makeMigrationDir(tmpRoot, 'dev_album_share')
    const migrations = await readMigrations(tmpRoot)
    await expect(commandRehash(rehashConn([]).conn, migrations, 'album_share', console)).rejects.toThrow(/not applied on this database/)
  })

  it('refuses sealed (numbered) migrations', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    const migrations = await readMigrations(tmpRoot)
    await expect(commandRehash(rehashConn([]).conn, migrations, '001_baseline', console)).rejects.toThrow(/immutable/)
  })
})

describe('commandDown dev checksum tolerance', () => {
  // The wiring, not just the helper: commandDown is the only caller that passes
  // { devChecksumMismatch: 'warn' }. Dropping it would make the SQL-first loop
  // (edit dev files -> down) throw before rolling back.
  function downConn(appliedRows: Array<{ version: string, checksum: string, applied_at: string }>) {
    const deletedVersions: unknown[][] = []
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM schema_migrations')) {
          return [appliedRows, []]
        }
        return [[], []]
      }),
      execute: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.startsWith('DELETE')) {
          deletedVersions.push(params)
        }
        return [{}, []]
      }),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    }
    return { conn: asConn(conn), deletedVersions }
  }

  it('rolls back an edited dev migration with a warning instead of throwing', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, 'dev_album', 'SELECT 1;', 'SELECT 42;')
    const migrations = await readMigrations(tmpRoot)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { conn, deletedVersions } = downConn([
      { version: '001_baseline', checksum: migrations[0]!.checksum, applied_at: '2026-01-01' },
      { version: 'dev_album', checksum: 'STALE_DIFFERENT', applied_at: '2026-01-02' },
    ])

    await expect(commandDown(conn, migrations, { to: '001_baseline' }, console)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dev_album'))
    expect(deletedVersions).toEqual([['dev_album']])
  })

  it('still hard-fails on a numbered checksum mismatch during down', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, '002_numbered')
    const migrations = await readMigrations(tmpRoot)
    const { conn } = downConn([
      { version: '001_baseline', checksum: migrations[0]!.checksum, applied_at: '2026-01-01' },
      { version: '002_numbered', checksum: 'STALE_DIFFERENT', applied_at: '2026-01-02' },
    ])

    await expect(commandDown(conn, migrations, { to: '001_baseline' }, console)).rejects.toThrow(/Checksum mismatch for migration 002_numbered/)
  })
})

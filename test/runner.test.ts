import type { MigrationConnection } from '../src'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunner, parseArgs } from '../src'

async function makeMigrationDir(root: string, name: string, upSql = 'SELECT 1;', downSql = 'SELECT 1;'): Promise<void> {
  const dir = path.join(root, name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'up.sql'), upSql)
  await fsp.writeFile(path.join(dir, 'down.sql'), downSql)
}

interface Row { version: string, description: string, checksum: string }

/**
 * In-memory schema_migrations + advisory lock, enough to drive the whole runner
 * without a database. `connect()` hands back the same instance so state persists
 * across a test's runner calls.
 */
class FakeDb {
  rows = new Map<string, Row>()
  getLockCount = 0
  releaseLockCount = 0
  endCount = 0
  hasUserTables = false

  async query(sql: string): Promise<[unknown, unknown]> {
    if (sql.includes('FROM schema_migrations')) {
      const list = [...this.rows.values()].map(r => ({ ...r, applied_at: '2026-01-01' }))
      return [list, []]
    }
    return [[], []]
  }

  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    if (sql.includes('GET_LOCK')) {
      this.getLockCount += 1
      return [[{ lock_acquired: 1 }], []]
    }
    if (sql.includes('RELEASE_LOCK')) {
      this.releaseLockCount += 1
      return [[], []]
    }
    if (sql.includes('information_schema.tables')) {
      return [[{ cnt: this.hasUserTables ? 5 : 0 }], []]
    }
    if (sql.includes('INSERT INTO schema_migrations')) {
      const [version, description, checksum] = params as [string, string, string]
      this.rows.set(version, { version, description, checksum })
      return [{}, []]
    }
    if (sql.startsWith('DELETE')) {
      this.rows.delete(params[0] as string)
      return [{}, []]
    }
    if (sql.startsWith('UPDATE schema_migrations SET version')) {
      const [newVersion, description, oldVersion] = params as [string, string, string]
      const existing = this.rows.get(oldVersion)
      this.rows.delete(oldVersion)
      this.rows.set(newVersion, { version: newVersion, description, checksum: existing?.checksum ?? '' })
      return [{}, []]
    }
    if (sql.startsWith('UPDATE schema_migrations SET checksum')) {
      const [checksum, version] = params as [string, string]
      const existing = this.rows.get(version)
      if (existing) {
        existing.checksum = checksum
      }
      return [{}, []]
    }
    if (sql.startsWith('SELECT version, checksum FROM schema_migrations WHERE')) {
      const row = this.rows.get(params[0] as string)
      return [row ? [row] : [], []]
    }
    return [[], []]
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async end(): Promise<void> {
    this.endCount += 1
  }
}

function makeRunner(migrationsDir: string, db: FakeDb, log: string[]) {
  return createRunner({
    migrationsDir,
    databaseName: 'testdb',
    connect: async () => db as unknown as MigrationConnection,
    logger: {
      log: (msg: string) => log.push(String(msg)),
      warn: (msg: string) => log.push(`WARN ${msg}`),
      error: (msg: string) => log.push(`ERROR ${msg}`),
    },
  })
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sealed-migrations-runner-'))
})

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('parseArgs', () => {
  it('separates flags, key=value, key value and positionals', () => {
    expect(parseArgs(['up', '--allow-dev', '--to=005_x'])).toEqual({
      args: { 'allow-dev': true, 'to': '005_x' },
      positionals: ['up'],
    })
    expect(parseArgs(['seal', 'my_slug'])).toEqual({
      args: {},
      positionals: ['seal', 'my_slug'],
    })
    expect(parseArgs(['down', '--to', 'none'])).toEqual({
      args: { to: 'none' },
      positionals: ['down'],
    })
  })
})

describe('createRunner guard', () => {
  it('refuses up() with a dev migration and no allowDev, before opening a connection', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, 'dev_alpha')
    const db = new FakeDb()
    const connectSpy = vi.fn(async () => db as unknown as MigrationConnection)
    const runner = createRunner({ migrationsDir: tmpRoot, connect: connectSpy })

    await expect(runner.up()).rejects.toThrow(/Refusing to run "up" with unsealed dev migrations/)
    expect(connectSpy).not.toHaveBeenCalled()
  })
})

describe('createRunner lifecycle', () => {
  it('applies numbered + dev in order, reports current, acquires and releases the lock', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, '002_numbered')
    await makeMigrationDir(tmpRoot, 'dev_alpha')
    const db = new FakeDb()
    const log: string[] = []
    const runner = makeRunner(tmpRoot, db, log)

    await runner.up({ allowDev: true })
    expect([...db.rows.keys()]).toEqual(['001_baseline', '002_numbered', 'dev_alpha'])
    expect(db.getLockCount).toBe(1)
    expect(db.releaseLockCount).toBe(1)
    expect(db.endCount).toBe(1)

    log.length = 0
    await runner.current()
    expect(log).toContain('dev_alpha')

    log.length = 0
    await runner.status()
    expect(log.some(l => l.startsWith('APPLIED') && l.includes('dev_alpha'))).toBe(true)
  })

  it('does not acquire the lock for read-only status', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    const db = new FakeDb()
    const runner = makeRunner(tmpRoot, db, [])
    await runner.status()
    expect(db.getLockCount).toBe(0)
    expect(db.endCount).toBe(1)
  })

  it('seals a dev migration end to end: renames the folder and updates the row', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, '002_numbered')
    await makeMigrationDir(tmpRoot, 'dev_alpha')
    const db = new FakeDb()
    const runner = makeRunner(tmpRoot, db, [])

    await runner.up({ allowDev: true })
    await runner.seal('alpha')

    await expect(fsp.access(path.join(tmpRoot, '003_alpha', 'up.sql'))).resolves.toBeUndefined()
    await expect(fsp.access(path.join(tmpRoot, 'dev_alpha'))).rejects.toThrow()
    expect(db.rows.has('003_alpha')).toBe(true)
    expect(db.rows.has('dev_alpha')).toBe(false)

    // After sealing there are no dev folders, so a bare up() (no allowDev) is allowed.
    await expect(runner.up()).resolves.toBeUndefined()
  })

  it('runCli dispatches commands and rejects unknown/empty input', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, 'dev_alpha')
    const db = new FakeDb()
    const runner = makeRunner(tmpRoot, db, [])

    await runner.runCli(['up', '--allow-dev'])
    expect(db.rows.has('dev_alpha')).toBe(true)

    await runner.runCli(['seal', 'alpha'])
    expect(db.rows.has('003_alpha') || db.rows.has('002_alpha')).toBe(true)

    await expect(runner.runCli([])).rejects.toThrow(/No command given/)
    await expect(runner.runCli(['bogus'])).rejects.toThrow(/Unknown command: bogus/)
    // --help / -h print usage and return cleanly (no throw).
    await expect(runner.runCli(['--help'])).resolves.toBeUndefined()
    await expect(runner.runCli(['-h'])).resolves.toBeUndefined()
    await expect(runner.runCli(['help'])).resolves.toBeUndefined()
  })
})

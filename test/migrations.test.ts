import type { Migration } from '../src'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeNextSealNumber,
  isDevVersion,
  normalizeDevVersion,
  parseMigrationDirName,
  readMigrations,
  validateAppliedState,
} from '../src'

async function makeMigrationDir(root: string, name: string, upSql = 'SELECT 1;', downSql = 'SELECT 1;'): Promise<string> {
  const dir = path.join(root, name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'up.sql'), upSql)
  await fsp.writeFile(path.join(dir, 'down.sql'), downSql)
  return dir
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sealed-migrations-'))
})

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('parseMigrationDirName', () => {
  it('parses a numbered migration', () => {
    expect(parseMigrationDirName('002_add_column_x')).toEqual({
      isDev: false,
      sortNumber: 2,
      version: '002_add_column_x',
      description: 'add column x',
    })
  })

  it('parses a dev migration with an infinite sort number', () => {
    expect(parseMigrationDirName('dev_album_share')).toEqual({
      isDev: true,
      sortNumber: Number.POSITIVE_INFINITY,
      version: 'dev_album_share',
      description: 'album share',
    })
  })

  it('rejects names matching neither pattern', () => {
    expect(() => parseMigrationDirName('feature_x')).toThrow(/Invalid migration directory name/)
    expect(() => parseMigrationDirName('dev_')).toThrow(/Invalid migration directory name/)
    expect(() => parseMigrationDirName('dev_Álbum')).toThrow(/Invalid migration directory name/)
  })
})

describe('isDevVersion', () => {
  it('detects dev versions only', () => {
    expect(isDevVersion('dev_foo')).toBe(true)
    expect(isDevVersion('058_album')).toBe(false)
    expect(isDevVersion('devfoo')).toBe(false)
  })
})

describe('readMigrations ordering', () => {
  it('sorts numbered migrations first, then dev migrations alphabetically', async () => {
    await makeMigrationDir(tmpRoot, '010_later')
    await makeMigrationDir(tmpRoot, 'dev_zeta')
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, 'dev_alpha')
    await makeMigrationDir(tmpRoot, '002_second')

    const migrations = await readMigrations(tmpRoot)
    expect(migrations.map(m => m.version)).toEqual([
      '001_baseline',
      '002_second',
      '010_later',
      'dev_alpha',
      'dev_zeta',
    ])
  })

  it('keeps duplicate numeric prefixes deterministic (alphabetical tie-break)', async () => {
    await makeMigrationDir(tmpRoot, '001_baseline')
    await makeMigrationDir(tmpRoot, '080_cron_schedule_offsets_oom')
    await makeMigrationDir(tmpRoot, '080_cron_mm_crawl_stack')

    const migrations = await readMigrations(tmpRoot)
    expect(migrations.map(m => m.version)).toEqual([
      '001_baseline',
      '080_cron_mm_crawl_stack',
      '080_cron_schedule_offsets_oom',
    ])
  })

  it('throws when up.sql or down.sql is missing', async () => {
    const dir = path.join(tmpRoot, '001_baseline')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'up.sql'), 'SELECT 1;')
    await expect(readMigrations(tmpRoot)).rejects.toThrow(/must contain up.sql and down.sql/)
  })
})

describe('normalizeDevVersion', () => {
  it('accepts a bare slug and a dev_ prefixed slug', () => {
    expect(normalizeDevVersion('album')).toBe('dev_album')
    expect(normalizeDevVersion('dev_album')).toBe('dev_album')
  })

  it('refuses a sealed (numbered) version', () => {
    expect(() => normalizeDevVersion('058_album')).toThrow(/immutable/)
  })

  it('refuses an empty or invalid slug', () => {
    expect(() => normalizeDevVersion('')).toThrow(/Missing dev migration slug/)
    expect(() => normalizeDevVersion('Álbum!')).toThrow(/Invalid dev migration slug/)
  })
})

describe('computeNextSealNumber', () => {
  const repo = [
    { isDev: false, sortNumber: 58, version: '058_album' },
    { isDev: true, sortNumber: Number.POSITIVE_INFINITY, version: 'dev_foo' },
  ] as Migration[]

  it('uses repo max + 1 when the DB has nothing newer', () => {
    expect(computeNextSealNumber(repo, ['058_album', 'dev_foo'])).toBe('059')
  })

  it('respects numbers claimed by in-flight branches on the dev DB', () => {
    expect(computeNextSealNumber(repo, ['058_album', '059_other_branch'])).toBe('060')
  })

  it('starts at 001 with no numbered migrations anywhere', () => {
    expect(computeNextSealNumber([], [])).toBe('001')
  })
})

describe('validateAppliedState', () => {
  const repoMigrations = [
    { isDev: false, sortNumber: 1, version: '001_baseline', description: 'baseline', checksum: 'aaa' },
    { isDev: true, sortNumber: Number.POSITIVE_INFINITY, version: 'dev_album', description: 'album', checksum: 'bbb' },
  ] as Migration[]

  it('only warns about an applied dev migration missing from the repo', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const applied = new Map([
      ['001_baseline', { checksum: 'aaa' }],
      ['dev_other_branch', { checksum: 'zzz' }],
    ])

    expect(() => validateAppliedState(repoMigrations, applied)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dev_other_branch'))
  })

  it('still hard-fails on an applied numbered migration missing from the repo', () => {
    const applied = new Map([['099_gone', { checksum: 'zzz' }]])
    expect(() => validateAppliedState(repoMigrations, applied)).toThrow(/099_gone is missing in repository/)
  })

  it('hard-fails on a checksum mismatch of a numbered migration', () => {
    const applied = new Map([['001_baseline', { checksum: 'CHANGED' }]])
    expect(() => validateAppliedState(repoMigrations, applied)).toThrow(/Checksum mismatch for migration 001_baseline/)
  })

  it('hard-fails on a dev checksum mismatch and suggests re-apply/rehash', () => {
    const applied = new Map([['dev_album', { checksum: 'CHANGED' }]])
    expect(() => validateAppliedState(repoMigrations, applied)).toThrow(/rehash album/)
  })

  it('only warns on a dev checksum mismatch in warn mode (the down path)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const applied = new Map([['dev_album', { checksum: 'CHANGED' }]])
    expect(() => validateAppliedState(repoMigrations, applied, { devChecksumMismatch: 'warn' })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dev_album'))
  })

  it('still hard-fails on a numbered checksum mismatch in warn mode', () => {
    const applied = new Map([['001_baseline', { checksum: 'CHANGED' }]])
    expect(() => validateAppliedState(repoMigrations, applied, { devChecksumMismatch: 'warn' })).toThrow(/Checksum mismatch for migration 001_baseline/)
  })
})

import type { DownOptions, MigrationConnection, RunnerConfig, UpOptions } from './types'
import path from 'node:path'
import process from 'node:process'
import {
  assertDevMigrationsAllowed,
  commandCurrent,
  commandDown,
  commandRehash,
  commandSeal,
  commandStatus,
  commandUp,
} from './commands'
import { readMigrations } from './migrations'
import { acquireLock, ensureSchemaMigrationsTable, releaseLock } from './state'

const DEFAULT_LOCK_NAME = 'sealed-migrations:lock'
const DEFAULT_LOCK_TIMEOUT_SEC = 120

export interface ParsedArgs {
  args: Record<string, string | boolean>
  positionals: string[]
}

/** Minimal `--flag`, `--key=value`, `--key value` and positional parser. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: Record<string, string | boolean> = {}
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? ''
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const eqIndex = token.indexOf('=')
    if (eqIndex >= 0) {
      args[token.slice(2, eqIndex)] = token.slice(eqIndex + 1)
      continue
    }

    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i += 1
    }
    else {
      args[key] = true
    }
  }

  return { args, positionals }
}

export interface Runner {
  up: (options?: UpOptions) => Promise<void>
  down: (options: DownOptions) => Promise<void>
  seal: (slug: string) => Promise<void>
  rehash: (slug: string) => Promise<void>
  current: () => Promise<void>
  status: () => Promise<void>
  /** Parses `argv` (without node/script), dispatches, and throws on error. */
  runCli: (argv: string[]) => Promise<void>
}

function usage(): string {
  return [
    'Usage:',
    '  up [--allow-dev] [--to=<version>]',
    '  down --to=<version>',
    '  seal <slug>',
    '  rehash <slug>',
    '  current',
    '  status',
    '',
    'Dev migrations (dev_<slug>/) apply after all numbered migrations,',
    'alphabetically. "up" refuses them without --allow-dev.',
    '"seal <slug>" assigns the next free number right before merge.',
    '"rehash <slug>" aligns the stored checksum after a manual schema change.',
  ].join('\n')
}

function strOpt(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function createRunner(config: RunnerConfig): Runner {
  const logger = config.logger ?? console
  const lockName = config.lockName ?? DEFAULT_LOCK_NAME
  const lockTimeoutSec = config.lockTimeoutSec ?? DEFAULT_LOCK_TIMEOUT_SEC
  const migrationsDir = path.resolve(process.cwd(), config.migrationsDir)

  async function withConnection<T>(useLock: boolean, fn: (conn: MigrationConnection) => Promise<T>): Promise<T> {
    const conn = await config.connect()
    let lockAcquired = false
    try {
      if (config.assertServer) {
        await config.assertServer(conn)
      }
      await ensureSchemaMigrationsTable(conn)
      if (useLock) {
        await acquireLock(conn, lockName, lockTimeoutSec)
        lockAcquired = true
      }
      return await fn(conn)
    }
    finally {
      if (lockAcquired) {
        await releaseLock(conn, lockName)
      }
      if (conn.end) {
        await conn.end()
      }
    }
  }

  const runner: Runner = {
    async up(options = {}) {
      const migrations = await readMigrations(migrationsDir)
      // Fail closed before opening a connection: the guard needs no DB.
      assertDevMigrationsAllowed(migrations, Boolean(options.allowDev))
      await withConnection(true, conn => commandUp(conn, migrations, config, options, logger))
    },
    async down(options) {
      const migrations = await readMigrations(migrationsDir)
      await withConnection(true, conn => commandDown(conn, migrations, options, logger))
    },
    async seal(slug) {
      const migrations = await readMigrations(migrationsDir)
      await withConnection(true, conn => commandSeal(conn, migrations, migrationsDir, slug, logger))
    },
    async rehash(slug) {
      const migrations = await readMigrations(migrationsDir)
      await withConnection(true, conn => commandRehash(conn, migrations, slug, logger))
    },
    async current() {
      const migrations = await readMigrations(migrationsDir)
      await withConnection(false, conn => commandCurrent(conn, migrations, logger))
    },
    async status() {
      const migrations = await readMigrations(migrationsDir)
      await withConnection(false, conn => commandStatus(conn, migrations, logger))
    },
    async runCli(argv) {
      const { args, positionals } = parseArgs(argv)
      const command = positionals[0] ?? ''

      // `--help` / `-h` arrive as flags (or the bare `-h`/`help` positional),
      // never as a `command`, so resolve help before dispatch.
      if (args.help || args.h || command === 'help' || command === '-h') {
        logger.log(usage())
        return
      }

      if (!command) {
        logger.log(usage())
        throw new Error('No command given')
      }

      switch (command) {
        case 'up':
          await runner.up({ to: strOpt(args.to), allowDev: Boolean(args['allow-dev']) })
          return
        case 'down':
          await runner.down({ to: strOpt(args.to) })
          return
        case 'seal':
          await runner.seal(strOpt(args.slug) ?? positionals[1] ?? '')
          return
        case 'rehash':
          await runner.rehash(strOpt(args.slug) ?? positionals[1] ?? '')
          return
        case 'current':
          await runner.current()
          return
        case 'status':
          await runner.status()
          return
        default:
          throw new Error(`Unknown command: ${command}`)
      }
    },
  }

  return runner
}

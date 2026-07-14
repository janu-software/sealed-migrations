import type { Connection } from 'mysql2/promise'
import type { MigrationConnection } from '../src/types'

// Compile-time only (checked by `pnpm typecheck`, never run by vitest): a real
// mysql2 Connection must satisfy MigrationConnection, so a consumer can write
// `connect: () => mysql.createConnection(...)` without a cast. If mysql2 ever
// tightens its types and breaks this, typecheck fails here instead of silently
// pushing the cast onto every consumer.
declare const mysql2Connection: Connection
export const _mysql2SatisfiesContract: MigrationConnection = mysql2Connection

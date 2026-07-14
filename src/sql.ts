/**
 * A tiny SQL splitter aware of string/identifier quoting and comments, so a
 * migration file can hold multiple statements. It is deliberately conservative:
 * it never tries to understand SQL, only where one statement ends.
 */
export function stripLeadingComments(statement: string): string {
  let sql = statement.trimStart()

  while (sql.length > 0) {
    if (sql.startsWith('--')) {
      const nextLine = sql.indexOf('\n')
      if (nextLine === -1) {
        return ''
      }
      sql = sql.slice(nextLine + 1).trimStart()
      continue
    }

    if (sql.startsWith('#')) {
      const nextLine = sql.indexOf('\n')
      if (nextLine === -1) {
        return ''
      }
      sql = sql.slice(nextLine + 1).trimStart()
      continue
    }

    if (sql.startsWith('/*')) {
      // MySQL versioned comments (/*! ... */) are executable directives, so
      // baseline dumps keep required session settings.
      if (sql.startsWith('/*!')) {
        return sql
      }

      const commentEnd = sql.indexOf('*/')
      if (commentEnd === -1) {
        return ''
      }
      sql = sql.slice(commentEnd + 2).trimStart()
      continue
    }

    return sql
  }

  return ''
}

export function splitSqlStatements(sqlFileContent: string): string[] {
  const statements: string[] = []
  let current = ''

  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < sqlFileContent.length; i += 1) {
    const char = sqlFileContent[i]
    const next = sqlFileContent[i + 1]

    if (inLineComment) {
      current += char
      if (char === '\n') {
        inLineComment = false
      }
      continue
    }

    if (inBlockComment) {
      current += char
      if (char === '*' && next === '/') {
        current += '/'
        i += 1
        inBlockComment = false
      }
      continue
    }

    if (!inSingle && !inDouble && !inBacktick) {
      const isDashComment = char === '-' && next === '-' && /\s/.test(sqlFileContent[i + 2] ?? '')
      if (isDashComment) {
        inLineComment = true
        current += char
        current += next
        i += 1
        continue
      }

      if (char === '#') {
        inLineComment = true
        current += char
        continue
      }

      if (char === '/' && next === '*') {
        inBlockComment = true
        current += char
        current += next
        i += 1
        continue
      }

      if (char === ';') {
        const trimmed = current.trim()
        if (trimmed) {
          statements.push(trimmed)
        }
        current = ''
        continue
      }
    }

    if (!inDouble && !inBacktick && char === '\'') {
      if (inSingle && next === '\'') {
        current += '\'\''
        i += 1
        continue
      }
      inSingle = !inSingle
      current += char
      continue
    }

    if (!inSingle && !inBacktick && char === '"') {
      if (inDouble && next === '"') {
        current += '""'
        i += 1
        continue
      }
      inDouble = !inDouble
      current += char
      continue
    }

    if (!inSingle && !inDouble && char === '`') {
      inBacktick = !inBacktick
      current += char
      continue
    }

    current += char
  }

  const last = current.trim()
  if (last) {
    statements.push(last)
  }

  return statements
}

/**
 * Picks the transaction mode for a migration file. An explicit
 * `-- migrate: tx | no-tx | auto` directive wins; otherwise DDL forces the
 * non-transactional path (MySQL/MariaDB cannot roll back DDL).
 */
export function resolveTxMode(sql: string, statements: string[]): 'transactional' | 'non_transactional' {
  const directive = sql.match(/--\s*migrate:\s*(tx|no-tx|auto)/i)?.[1]?.toLowerCase()
  if (directive === 'tx') {
    return 'transactional'
  }
  if (directive === 'no-tx') {
    return 'non_transactional'
  }

  const ddlRegex = /^(?:ALTER|CREATE|DROP|TRUNCATE|RENAME|LOCK|UNLOCK)\b/i
  const hasDdl = statements.some(statement => ddlRegex.test(stripLeadingComments(statement)))
  return hasDdl ? 'non_transactional' : 'transactional'
}

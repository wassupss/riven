import type { DbKind } from './sqlText'

// What each engine supports, so the panels offer only what works. Pure: shared
// by main (dispatch) and the renderer (menus, forms).

export interface EngineCaps {
  label: string
  /** Host, port, user and password (SQLite is a file). */
  network: boolean
  defaultPort: number
  defaultUser: string
  /** Database a connection opens when none is named ('' = none). */
  defaultDb: string
  /** The explorer shows a database level / a schema level. */
  databases: boolean
  schemas: boolean
  createDatabase: boolean
  createSchema: boolean
  /** Table designer (CREATE / ALTER TABLE). */
  designer: boolean
  /** Views, functions, materialized views created from the explorer. */
  createView: boolean
  drop: boolean
  rename: boolean
  truncate: boolean
  /** Grid editing of a result's rows. */
  edit: boolean
  /** Manual-commit console tabs. */
  sessions: boolean
  explain: boolean
  roles: boolean
  monitor: boolean
  backup: boolean
  diff: boolean
  erd: boolean
  search: boolean
  import: boolean
}

const OFF = {
  createSchema: false,
  designer: false,
  createView: false,
  explain: false,
  roles: false,
  monitor: false,
  backup: false,
  diff: false,
  erd: false,
  search: false,
  import: false
}

export const ENGINES: Record<Exclude<DbKind, 'redis'>, EngineCaps> = {
  postgres: {
    label: 'PostgreSQL',
    network: true,
    defaultPort: 5432,
    defaultUser: 'postgres',
    defaultDb: 'postgres',
    databases: true,
    schemas: true,
    createDatabase: true,
    createSchema: true,
    designer: true,
    createView: true,
    drop: true,
    rename: true,
    truncate: true,
    edit: true,
    sessions: true,
    explain: true,
    roles: true,
    monitor: true,
    backup: true,
    diff: true,
    erd: true,
    search: true,
    import: true
  },
  mysql: {
    ...OFF,
    label: 'MySQL / MariaDB',
    network: true,
    defaultPort: 3306,
    defaultUser: 'root',
    defaultDb: '',
    databases: true,
    schemas: false,
    createDatabase: true,
    drop: true,
    rename: true,
    truncate: true,
    edit: true,
    sessions: true
  },
  sqlite: {
    ...OFF,
    label: 'SQLite',
    network: false,
    defaultPort: 0,
    defaultUser: '',
    defaultDb: 'main',
    databases: false,
    schemas: false,
    createDatabase: false,
    drop: true,
    rename: true,
    truncate: true,
    edit: true,
    sessions: true
  }
}

export const ENGINE_KINDS = Object.keys(ENGINES) as Array<keyof typeof ENGINES>

/** Caps of a kind; unknown kinds (redis, not built yet) get SQLite's minimal set minus editing. */
export function caps(kind: DbKind): EngineCaps {
  return kind === 'redis' ? { ...ENGINES.sqlite, label: 'Redis', edit: false, sessions: false } : ENGINES[kind]
}

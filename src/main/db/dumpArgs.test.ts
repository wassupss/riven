import { describe, expect, it } from 'vitest'
import { dumpArgs, parseToc, plainLineFilter, parseToolVersion, patternOf, plainHeader, progressObject, restoreArgs, serverMajor, sniffFormat, toolEnv, type BackupOptions, type RestoreOptions } from './dumpArgs'
import type { ConnectionConfig } from './types'

const cfg: ConnectionConfig = { id: 'x', name: 'x', kind: 'postgres', host: 'db.local', port: 6543, user: 'app', database: 'main', readOnly: false }
const backup = (o: Partial<BackupOptions> = {}): BackupOptions => ({
  format: 'custom',
  content: 'all',
  schemas: [],
  tables: [],
  noOwner: false,
  noPrivileges: false,
  clean: false,
  create: false,
  rows: 'copy',
  compress: 6,
  jobs: 1,
  ...o
})
const restore = (o: Partial<RestoreOptions> = {}): RestoreOptions => ({
  path: '/tmp/a.dump',
  format: 'custom',
  content: 'all',
  schemas: [],
  clean: false,
  noOwner: false,
  noPrivileges: false,
  singleTransaction: false,
  exitOnError: false,
  jobs: 1,
  ...o
})

describe('toolEnv', () => {
  it('passes the connection and password through libpq variables', () => {
    const env = toolEnv(cfg, 'other', 'pw', '/home/me')
    expect(env).toMatchObject({ PGHOST: 'db.local', PGPORT: '6543', PGUSER: 'app', PGDATABASE: 'other', PGPASSWORD: 'pw', PGSSLMODE: 'disable' })
    expect(toolEnv(cfg, undefined, undefined, '/h').PGDATABASE).toBe('main')
    expect(toolEnv(cfg, undefined, undefined, '/h').PGPASSWORD).toBeUndefined()
  })
  it('maps SSL settings and expands ~', () => {
    const env = toolEnv({ ...cfg, ssl: { mode: 'verify-full', ca: '~/ca.pem' } }, undefined, undefined, '/home/me')
    expect(env.PGSSLMODE).toBe('verify-full')
    expect(env.PGSSLROOTCERT).toBe('/home/me/ca.pem')
  })
})

describe('dumpArgs', () => {
  it('quotes schema and table patterns so they match literally', () => {
    expect(patternOf('My"S', 'a*b')).toBe('"My""S"."a*b"')
    const a = dumpArgs(backup({ schemas: ['public'], tables: [['ref', 'Countries']] }), '/out/x.dump')
    expect(a).toContain('--schema="public"')
    expect(a).toContain('--table="ref"."Countries"')
    expect(a).toContain('--file=/out/x.dump')
    expect(a).toContain('--compress=6')
  })
  it('keeps format-specific flags to their formats', () => {
    const plain = dumpArgs(backup({ format: 'plain', clean: true, create: true, compress: 9, jobs: 4, rows: 'column-inserts' }), 'f.sql')
    expect(plain).toEqual(expect.arrayContaining(['--clean', '--if-exists', '--create', '--column-inserts']))
    expect(plain.some((x) => x.startsWith('--compress') || x.startsWith('--jobs'))).toBe(false)
    const dir = dumpArgs(backup({ format: 'directory', jobs: 4, clean: true }), 'd')
    expect(dir).toContain('--jobs=4')
    expect(dir).not.toContain('--clean')
    const schemaOnly = dumpArgs(backup({ content: 'schema', rows: 'inserts' }), 'f')
    expect(schemaOnly).toContain('--schema-only')
    expect(schemaOnly).not.toContain('--inserts')
  })
})

describe('restoreArgs', () => {
  it('runs plain SQL through psql', () => {
    const r = restoreArgs(restore({ format: 'plain', path: '/a.sql', exitOnError: true, singleTransaction: true, jobs: 4 }))
    expect(r.tool).toBe('psql')
    expect(r.args).toEqual(['--no-psqlrc', '--echo-errors', '--file=/a.sql', '--set=ON_ERROR_STOP=1', '--single-transaction'])
  })
  it('reads plain SQL from stdin when filtered', () => {
    expect(restoreArgs(restore({ format: 'plain', path: '/a.sql' }), true).args).toContain('--file=-')
    expect(restoreArgs(restore({ format: 'plain', singleTransaction: true })).args).toContain('--set=ON_ERROR_STOP=1')
    expect(restoreArgs(restore({ format: 'plain' })).args).not.toContain('--set=ON_ERROR_STOP=1')
  })
  it('drops settings an older server rejects', () => {
    const keep = plainLineFilter(16)
    expect(keep?.('SET transaction_timeout = 0;')).toBe(false)
    expect(keep?.('SET lock_timeout = 0;')).toBe(true)
    expect(plainLineFilter(17)).toBeNull()
  })
  it('restores archives into the environment database', () => {
    const r = restoreArgs(restore({ clean: true, schemas: ['public'], jobs: 3 }))
    expect(r.tool).toBe('pg_restore')
    expect(r.args).toEqual(expect.arrayContaining(['--dbname=', '--clean', '--if-exists', '--schema=public', '--jobs=3']))
    expect(r.args[r.args.length - 1]).toBe('/tmp/a.dump')
    // One transaction and parallel workers don't mix.
    const one = restoreArgs(restore({ singleTransaction: true, jobs: 3 })).args
    expect(one).toContain('--single-transaction')
    expect(one.some((x) => x.startsWith('--jobs'))).toBe(false)
  })
})

describe('versions and files', () => {
  it('reads tool and server versions', () => {
    expect(parseToolVersion('pg_dump (PostgreSQL) 16.2 (Homebrew)')).toEqual({ version: '16.2', major: 16 })
    expect(parseToolVersion('pg_dump (PostgreSQL) 9.6.24')).toEqual({ version: '9.6', major: 9.6 })
    expect(parseToolVersion('nope')).toBeNull()
    expect(serverMajor(160002)).toBe(16)
    expect(serverMajor(90624)).toBe(9.6)
  })
  it('sniffs archive formats', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
    expect(sniffFormat(enc('PGDMP\x01\x0f'), false)).toBe('custom')
    const tar = new Uint8Array(512)
    tar.set(enc('ustar'), 257)
    expect(sniffFormat(tar, false)).toBe('tar')
    expect(sniffFormat(enc('--\n-- PostgreSQL database dump\n'), false)).toBe('plain')
    expect(sniffFormat(new Uint8Array(), true)).toBe('directory')
  })
  it('reads plain dump headers', () => {
    expect(plainHeader('--\n-- Dumped from database version 16.2\n-- Dumped by pg_dump version 18.0\n')).toEqual({ serverVersion: '16.2', dumpVersion: '18.0' })
  })
  it('summarizes a TOC listing', () => {
    const toc = [
      ';',
      '; Archive created at 2026-10-23 10:00:00 KST',
      ';     dbname: postgres',
      ';     Dumped from database version: 16.2',
      ';     Dumped by pg_dump version: 18.0',
      ';',
      '6; 2615 16400 SCHEMA - ref postgres',
      '215; 1259 16385 TABLE public users postgres',
      '216; 1259 16390 TABLE ref countries postgres',
      '3345; 0 16385 TABLE DATA public users postgres',
      '3200; 2606 16399 CONSTRAINT public users users_pkey postgres',
      '3201; 2606 16401 FK CONSTRAINT public users users_country_fkey postgres',
      ';3202; 1259 1 INDEX public commented_out postgres'
    ].join('\n')
    const s = parseToc(toc)
    expect(s.database).toBe('postgres')
    expect(s.serverVersion).toBe('16.2')
    expect(s.dumpVersion).toBe('18.0')
    expect(s.schemas).toEqual(['public', 'ref'])
    expect(s.counts).toEqual({ SCHEMA: 1, TABLE: 2, 'TABLE DATA': 1, CONSTRAINT: 1, 'FK CONSTRAINT': 1 })
  })
  it('picks the object out of verbose lines', () => {
    expect(progressObject('pg_dump: dumping contents of table "public.users"')).toBe('public.users')
    expect(progressObject('pg_restore: processing data for table "public.orders"')).toBe('public.orders')
    expect(progressObject('pg_restore: creating TABLE "public.users"')).toBe('public.users')
    expect(progressObject('pg_dump: reading extensions')).toBeNull()
  })
})

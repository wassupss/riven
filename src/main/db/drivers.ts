import * as pg from './pg'
import * as meta from './meta'
import * as my from './mysql'
import * as myMeta from './mysqlMeta'
import * as sl from './sqlite'
import * as slMeta from './sqliteMeta'
import type { Driver } from './driver'
import type { DbKind } from './sqlText'

export const pgDriver: Driver = {
  test: pg.pgTest,
  query: pg.pgQuery,
  stream: pg.pgStream,
  execute: pg.pgExecute,
  ddl: pg.pgDdl,
  sessionQuery: pg.pgSessionQuery,
  sessionStatus: pg.pgSessionStatus,
  sessionEnd: pg.pgSessionEnd,
  sessionClose: pg.pgSessionClose,
  hasSession: pg.hasSession,
  apply: pg.pgApply,
  cancel: pg.pgCancel,
  closeConnection: pg.closeConnection,
  closeDatabase: pg.closeDatabase,
  closeAll: pg.closeAll,
  listDatabases: meta.listDatabases,
  listSchemas: meta.listSchemas,
  listObjects: meta.listObjects,
  findSchema: meta.findSchema,
  tableInfo: meta.tableInfo,
  columnDetail: meta.columnDetail,
  objectDdl: meta.objectDdl,
  editTarget: meta.editTarget,
  completionMeta: meta.completionMeta
}

export const mysqlDriver: Driver = {
  test: my.myTest,
  query: my.myQuery,
  stream: my.myStream,
  execute: my.myExecute,
  ddl: my.myDdl,
  sessionQuery: my.mySessionQuery,
  sessionStatus: my.mySessionStatus,
  sessionEnd: my.mySessionEnd,
  sessionClose: my.mySessionClose,
  hasSession: my.myHasSession,
  apply: my.myApply,
  cancel: my.myCancel,
  closeConnection: my.myCloseConnection,
  closeDatabase: my.myCloseDatabase,
  closeAll: my.myCloseAll,
  listDatabases: myMeta.listDatabases,
  listSchemas: myMeta.listSchemas,
  listObjects: myMeta.listObjects,
  findSchema: myMeta.findSchema,
  tableInfo: myMeta.tableInfo,
  columnDetail: myMeta.columnDetail,
  objectDdl: myMeta.objectDdl,
  editTarget: myMeta.editTarget,
  completionMeta: myMeta.completionMeta
}

export const sqliteDriver: Driver = {
  test: sl.slTest,
  query: sl.slQuery,
  stream: sl.slStream,
  execute: sl.slExecute,
  ddl: sl.slDdl,
  sessionQuery: sl.slSessionQuery,
  sessionStatus: sl.slSessionStatus,
  sessionEnd: sl.slSessionEnd,
  sessionClose: sl.slSessionClose,
  hasSession: sl.slHasSession,
  apply: sl.slApply,
  cancel: sl.slCancel,
  closeConnection: sl.slCloseConnection,
  closeDatabase: sl.slCloseDatabase,
  closeAll: sl.slCloseAll,
  listDatabases: slMeta.listDatabases,
  listSchemas: slMeta.listSchemas,
  listObjects: slMeta.listObjects,
  findSchema: slMeta.findSchema,
  tableInfo: slMeta.tableInfo,
  columnDetail: slMeta.columnDetail,
  objectDdl: slMeta.objectDdl,
  editTarget: slMeta.editTarget,
  completionMeta: slMeta.completionMeta
}

export const DRIVERS = [pgDriver, mysqlDriver, sqliteDriver]

export function driverOf(kind: DbKind): Driver {
  if (kind === 'postgres') return pgDriver
  if (kind === 'mysql') return mysqlDriver
  if (kind === 'sqlite') return sqliteDriver
  throw new Error(`${kind} connections are not supported yet`)
}

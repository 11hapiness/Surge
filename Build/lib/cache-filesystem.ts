import createDb from 'better-sqlite3';
import type { Database, Statement } from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import picocolors from 'picocolors';
import { fastStringArrayJoin } from 'foxts/fast-string-array-join';
import { performance } from 'node:perf_hooks';
// import type { UndiciResponseData } from './fetch-retry';

export interface CacheOptions<S = string> {
  /** Path to sqlite file dir */
  cachePath?: string,
  /** Time before deletion */
  tbd?: number,
  /** Cache table name */
  tableName?: string,
  type?: S extends string ? 'string' : 'buffer'
}

interface CacheApplyRawOption {
  ttl?: number | null,
  temporaryBypass?: boolean,
  incrementTtlWhenHit?: boolean
}

interface CacheApplyNonRawOption<T, S> extends CacheApplyRawOption {
  serializer: (value: T) => S,
  deserializer: (cached: S) => T
}

export type CacheApplyOption<T, S> = T extends S ? CacheApplyRawOption : CacheApplyNonRawOption<T, S>;

export class Cache<S = string> {
  private db: Database;
  /** Time before deletion */
  tbd = 60 * 1000;
  /** SQLite file path */
  cachePath: string;
  /** Table name */
  tableName: string;
  type: S extends string ? 'string' : 'buffer';

  private statement: {
    updateTtl: Statement<[number, string]>,
    del: Statement<[string]>,
    insert: Statement<[unknown]>,
    get: Statement<[string], { ttl: number, value: S }>
  };

  constructor({
    cachePath = path.join(os.tmpdir() || '/tmp', 'hdc'),
    tbd,
    tableName = 'cache',
    type
  }: CacheOptions<S> = {}) {
    const start = performance.now();

    this.cachePath = cachePath;
    mkdirSync(this.cachePath, { recursive: true });
    if (tbd != null) this.tbd = tbd;
    this.tableName = tableName;
    if (type) {
      this.type = type;
    } else {
      // @ts-expect-error -- fallback type
      this.type = 'string';
    }

    const db = createDb(path.join(this.cachePath, 'cache.db'));

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = normal');
    db.pragma('temp_store = memory');
    db.pragma('optimize');

    db.prepare(`CREATE TABLE IF NOT EXISTS ${this.tableName} (key TEXT PRIMARY KEY, value ${this.type === 'string' ? 'TEXT' : 'BLOB'}, ttl REAL NOT NULL);`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS cache_ttl ON ${this.tableName} (ttl);`).run();

    /** cache stmt */
    this.statement = {
      updateTtl: db.prepare(`UPDATE ${this.tableName} SET ttl = ? WHERE key = ?;`),
      del: db.prepare(`DELETE FROM ${this.tableName} WHERE key = ?`),
      insert: db.prepare(`INSERT INTO ${this.tableName} (key, value, ttl) VALUES ($key, $value, $valid) ON CONFLICT(key) DO UPDATE SET value = $value, ttl = $valid`),
      get: db.prepare(`SELECT ttl, value FROM ${this.tableName} WHERE key = ? LIMIT 1`)
    } as const;

    const date = new Date();

    // perform purge on startup

    // ttl + tbd < now => ttl < now - tbd
    const now = date.getTime() - this.tbd;
    db.prepare(`DELETE FROM ${this.tableName} WHERE ttl < ?`).run(now);

    this.db = db;

    const dateString = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    const lastVaccum = this.get('__LAST_VACUUM');
    if (lastVaccum === undefined || (lastVaccum !== dateString && date.getUTCDay() === 6)) {
      console.log(picocolors.magenta('[cache] vacuuming'));

      this.set('__LAST_VACUUM', dateString, 10 * 365 * 60 * 60 * 24 * 1000);
      this.db.exec('VACUUM;');
    }

    const end = performance.now();
    console.log(`${picocolors.gray(`[${((end - start)).toFixed(3)}ns]`)} cache initialized from ${this.tableName} @ ${this.cachePath}`);
  }

  set(key: string, value: string, ttl = 60 * 1000): void {
    const valid = Date.now() + ttl;

    this.statement.insert.run({
      $key: key,
      key,
      $value: value,
      value,
      $valid: valid,
      valid
    });
  }

  get(key: string): S | null {
    const rv = this.statement.get.get(key);

    if (!rv) return null;

    if (rv.ttl < Date.now()) {
      this.del(key);
      return null;
    }

    if (rv.value == null) {
      this.del(key);
      return null;
    }

    return rv.value;
  }

  updateTtl(key: string, ttl: number): void {
    this.statement.updateTtl.run(Date.now() + ttl, key);
  }

  del(key: string): void {
    this.statement.del.run(key);
  }

  destroy() {
    this.db.close();
  }

  deleteTable(tableName: string) {
    this.db.exec(`DROP TABLE IF EXISTS ${tableName};`);
  }
}

// process.on('exit', () => {
//   fsFetchCache.destroy();
// });

const separator = '\u0000';

export const serializeArray = (arr: string[]) => fastStringArrayJoin(arr, separator);
export const deserializeArray = (str: string) => str.split(separator);

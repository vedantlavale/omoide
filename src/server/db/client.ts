/**
 * One database handle, two deployments:
 *   - no DATABASE_URL  → embedded Postgres (PGlite, WASM) in ./.data/pglite
 *   - DATABASE_URL set → a real Postgres (Neon, RDS, local) via `pg`
 *
 * Both speak the same SQL dialect, so every query in this repo is written once.
 * `npm install && npm run dev` works with zero provisioning; production is one
 * environment variable away.
 *
 * The handle is a module-level singleton backed by globalThis: Next's dev
 * server re-evaluates modules on hot reload, and a second PGlite instance on
 * the same data directory would lock or corrupt it.
 */

import { SCHEMA_SQL } from './schema';

export interface Db {
  dialect: 'pglite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __recallDb: Promise<Db> | undefined;
}

function dataDir(): string {
  return process.env.PGLITE_DIR?.trim() || './.data/pglite';
}

async function createPglite(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const raw = await PGlite.create(dataDir());
  await raw.waitReady;
  await raw.exec(SCHEMA_SQL);
  return {
    dialect: 'pglite',
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await raw.query<T>(sql, params as unknown[]);
      return res.rows;
    },
    async exec(sql: string) {
      await raw.exec(sql);
    },
    async close() {
      await raw.close();
    },
  };
}

async function createPostgres(url: string): Promise<Db> {
  const pgMod = await import('pg');
  const Pool = (pgMod as unknown as { default: typeof import('pg') }).default?.Pool ?? pgMod.Pool;
  const pool = new Pool({
    connectionString: url,
    max: 5,
    ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query(SCHEMA_SQL);
  return {
    dialect: 'postgres',
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await pool.query(sql, params as unknown[]);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

export function getDb(): Promise<Db> {
  if (!globalThis.__recallDb) {
    const url = process.env.DATABASE_URL?.trim();
    globalThis.__recallDb = (url ? createPostgres(url) : createPglite()).catch((err) => {
      // Let the next call retry instead of caching a rejected promise forever.
      globalThis.__recallDb = undefined;
      throw err;
    });
  }
  return globalThis.__recallDb;
}

/** Used by evals to release the data directory between runs. */
export async function closeDb(): Promise<void> {
  const pending = globalThis.__recallDb;
  globalThis.__recallDb = undefined;
  if (pending) await (await pending).close();
}

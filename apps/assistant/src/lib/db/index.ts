import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  dbPool?: Pool;
};

function getPool(): Pool {
  if (!globalForDb.dbPool) {
    globalForDb.dbPool = new Pool({ connectionString: env.DATABASE_URL });
  }
  return globalForDb.dbPool;
}

let cachedDb: NodePgDatabase<typeof schema> | null = null;

export function getDb(): NodePgDatabase<typeof schema> {
  if (!cachedDb) {
    cachedDb = drizzle(getPool(), { schema });
  }
  return cachedDb;
}

export const db: NodePgDatabase<typeof schema> = new Proxy(
  {} as NodePgDatabase<typeof schema>,
  {
    get(_target, prop) {
      const real = getDb() as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === "function" ? value.bind(getDb()) : value;
    },
  },
);

export * from "./schema";

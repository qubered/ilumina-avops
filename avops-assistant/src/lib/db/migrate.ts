import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { getDb } from "./index";

/** Apply pending Drizzle migrations at boot (self-hosted, no external runner). */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  await migrate(getDb(), { migrationsFolder });
  console.log("[db] migrations up to date");
}

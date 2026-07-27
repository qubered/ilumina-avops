import pg from "pg";
import { env } from "../env.js";

/**
 * Shared Postgres pool for Mort's memory tables. Same database the assistant
 * and the legacy `sharepoint_imports` table use; Mort's tables are prefixed
 * `mort_` and created on boot (see schema.ts).
 */
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

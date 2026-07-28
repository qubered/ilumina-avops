/**
 * Runs once at server boot: fail fast on bad env, run pending DB migrations,
 * start the nightly sync cron.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getEnv } = await import("./lib/env");
  getEnv(); // throws with a readable message if the environment is invalid

  const { runMigrations } = await import("./lib/db/migrate");
  await runMigrations();

  // The admin UI now queries mort_* tables directly (no more HTTP boundary to
  // ingest, see mort-admin.ts) — idempotent, so safe even when ingest has
  // already created them, and necessary when the assistant boots first.
  const { ensureMortSchema } = await import("@mort/core/memory/schema");
  await ensureMortSchema();

  const { ensureOidcClientRow } = await import("./lib/db/seed-oidc-client");
  await ensureOidcClientRow();

  const { startCron } = await import("./lib/cron");
  startCron();
}

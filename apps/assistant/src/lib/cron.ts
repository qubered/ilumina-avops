import cron from "node-cron";
import { fullSync } from "./rag/sync";

const globalForCron = globalThis as unknown as { cronStarted?: boolean };

/**
 * Nightly full sync at 04:00 Australia/Sydney as a backstop for missed
 * webhooks (brief §6.4). Guarded singleton so hot reload / multiple imports
 * never double-schedule.
 */
export function startCron(): void {
  if (globalForCron.cronStarted) return;
  globalForCron.cronStarted = true;

  cron.schedule(
    "0 4 * * *",
    async () => {
      console.log("[cron] nightly KB sync starting");
      try {
        const { docCount, chunkCount } = await fullSync("cron");
        console.log(`[cron] nightly KB sync done: ${docCount} docs, ${chunkCount} chunks`);
      } catch (err) {
        console.error("[cron] nightly KB sync failed:", err);
      }
    },
    { timezone: "Australia/Sydney" },
  );
}

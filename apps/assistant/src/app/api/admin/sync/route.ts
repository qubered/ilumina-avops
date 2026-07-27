import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { fullSync, isFullSyncRunning } from "@/lib/rag/sync";

export async function POST() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  if (isFullSyncRunning()) {
    return NextResponse.json({ error: "A sync is already running." }, { status: 409 });
  }

  // Fire and forget; the admin page polls sync_runs for progress.
  fullSync("manual").catch((err) => console.error("[sync] manual sync failed:", err));

  return NextResponse.json({ started: true }, { status: 202 });
}

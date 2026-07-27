import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { isFullSyncRunning, resetIndex } from "@/lib/rag/sync";

/**
 * Hard-reset the KB index: drop both Qdrant collections and forget every
 * document and sync run. Used when starting Mort over (see ingest/RESET.md).
 *
 * Destructive and not reversible, but not dangerous: everything here is derived
 * from Outline, so a full sync rebuilds it.
 */
export async function POST() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  if (isFullSyncRunning()) {
    return NextResponse.json({ error: "A sync is running — wait for it to finish." }, { status: 409 });
  }

  try {
    const result = await resetIndex();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reset failed" },
      { status: 500 },
    );
  }
}

/**
 * MORT v1.4 STEP 0 — Outline round-trip probe.
 *
 * The whole never-destructive write-path hinges on one empirical question:
 * does Outline preserve the delimiters Mort uses to fence "his" region, and
 * how badly does its ProseMirror round-trip mangle content?
 *
 * This creates a throwaway doc containing the constructs Mort relies on,
 * reads it back via documents.info, and diffs. It reports a VERDICT that
 * decides the region-delimiter strategy (HTML comment vs heading boundary).
 *
 * Run (needs a bot API key with create/read/delete in some collection):
 *   OUTLINE_URL=https://kb.example \
 *   OUTLINE_API_KEY=... \
 *   pnpm --filter ilumina-ingest probe:outline           # or: tsx scripts/outline-roundtrip-probe.ts
 *
 * Flags: --keep  leave the test doc (default: delete what we created).
 *        --collection "<name>"  target collection (default: first available).
 *
 * Nothing here touches Mort's tables or existing docs — it only creates and
 * (by default) deletes the single doc it made.
 */

const BASE = (process.env.OUTLINE_URL ?? "").replace(/\/$/, "");
const KEY = process.env.OUTLINE_API_KEY ?? "";
const KEEP = process.argv.includes("--keep");
const collFlagIdx = process.argv.indexOf("--collection");
const COLL = collFlagIdx >= 0 ? process.argv[collFlagIdx + 1] : undefined;

if (!BASE || !KEY) {
  console.error("Set OUTLINE_URL and OUTLINE_API_KEY.");
  process.exit(1);
}

async function rpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return ((await res.json()) as { data: T }).data;
}

// The constructs Mort's write-path depends on, each independently checkable.
const MARKER_START = "<!-- mort:start -->";
const MARKER_END = "<!-- mort:end -->";
const SENT = [
  MARKER_START,
  "",
  "Mort-ID: probe-doc",
  "",
  "Zone: Main Stage",
  "",
  "System: Lighting",
  "",
  "## Mort — maintained section",
  "",
  "A sentinel paragraph with exact spacing.",
  "",
  "| Col A | Col B |",
  "| --- | --- |",
  "| 1 | pipe \\| escaped |",
  "",
  "1. step one",
  "2. step two",
  "",
  MARKER_END,
].join("\n");

function checks(returned: string) {
  return {
    "HTML comment start marker survives": returned.includes(MARKER_START),
    "HTML comment end marker survives": returned.includes(MARKER_END),
    "Heading boundary survives": /^##\s+Mort — maintained section$/m.test(returned),
    "Key: value lines survive": /^Mort-ID:\s*probe-doc$/m.test(returned) && /^Zone:\s*Main Stage$/m.test(returned),
    "Table survives": returned.includes("| Col A | Col B |"),
    "Escaped pipe in cell survives": /pipe \\?\| escaped/.test(returned),
    "Ordered list survives": /1\.\s*step one/.test(returned),
  };
}

async function main() {
  const collections = await rpc<Array<{ id: string; name: string }>>("collections.list", { limit: 100 });
  const target = COLL
    ? collections.find((c) => c.name.toLowerCase() === COLL.toLowerCase())
    : collections[0];
  if (!target) {
    console.error(COLL ? `Collection "${COLL}" not found.` : "No collections available.");
    process.exit(1);
  }

  const title = `MORT PROBE (safe to delete) ${Date.now()}`;
  const created = await rpc<{ id: string }>("documents.create", {
    title,
    text: SENT,
    collectionId: target.id,
    publish: true,
  });

  // Read back exactly what Outline stored/returns.
  const back = await rpc<{ text: string }>("documents.info", { id: created.id });
  const returned = back.text ?? "";

  const results = checks(returned);
  console.log(`\nOutline: ${BASE}  ·  collection: ${target.name}\n`);
  let anyFail = false;
  for (const [name, ok] of Object.entries(results)) {
    if (!ok) anyFail = true;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  }

  const commentsSurvive = results["HTML comment start marker survives"] && results["HTML comment end marker survives"];
  console.log("\n=== VERDICT ===");
  if (commentsSurvive) {
    console.log("HTML comment markers SURVIVE → v1.4 may use <!-- mort:start/end --> to fence Mort's region.");
  } else {
    console.log("HTML comment markers DROPPED → use the HEADING boundary ('## Mort — maintained section')");
    console.log("as the region delimiter, and splice-by-heading (byte-equality outside is impossible).");
  }
  if (anyFail) {
    console.log("Other FAILs above show what ProseMirror normalises — design the writer around them.");
  }

  console.log("\n--- exact returned text ---\n" + returned + "\n---------------------------");

  if (KEEP) {
    console.log(`\nLeft doc ${created.id} in place (--keep).`);
  } else {
    await rpc("documents.delete", { id: created.id });
    console.log(`\nDeleted probe doc ${created.id}.`);
  }
}

main().catch((err) => {
  console.error("Probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

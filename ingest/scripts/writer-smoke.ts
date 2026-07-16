/**
 * LIVE smoke test for the non-destructive writer (v1.4) against a real Outline.
 * Proves that Mort's region splicing survives Outline's actual ProseMirror
 * round-trip and never touches human content — end to end, on a throwaway doc
 * it creates and deletes.
 *
 * Run:  OUTLINE_URL=… OUTLINE_API_KEY=… INGEST_API_KEY=x DATABASE_URL=x \
 *       tsx scripts/writer-smoke.ts
 * (INGEST_API_KEY/DATABASE_URL only satisfy env validation; no DB is touched.)
 */
import {
  createDocument,
  deleteDocument,
  getDocument,
  listCollections,
  updateDocument,
} from "../src/outline.js";
import { extractMortRegion, spliceMortRegion } from "../src/mort/region.js";

let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
}

/** Splice + write Mort's region, mimicking writer.ts minus the Postgres state. */
async function setRegion(docId: string, body: string) {
  const doc = await getDocument(docId);
  const next = spliceMortRegion(doc.text, body);
  if (next !== doc.text) await updateDocument({ id: docId, title: doc.title, text: next, publish: true });
}

async function main() {
  const cols = await listCollections();
  if (!cols.length) throw new Error("no collections");
  const HUMAN_TOP = "# Human Procedure\n\nStep 1: do the thing. DO NOT let a bot rewrite this.";

  const created = await createDocument({
    title: `MORT WRITER SMOKE (safe to delete) ${Date.now()}`,
    text: HUMAN_TOP,
    collectionId: cols[0].id,
    publish: true,
  });
  const id = created.id;
  try {
    // 1. First region write (additive — no region existed).
    await setRegion(id, "Zone: Main Stage\n\nSystem: Lighting\n\n## Mort notes\n\nv1 content");
    let doc = await getDocument(id);
    check("human content preserved after first Mort write", doc.text.includes("DO NOT let a bot rewrite this"));
    check("Mort region present", (extractMortRegion(doc.text) ?? "").includes("v1 content"));

    // 2. Simulate a HUMAN editing the doc — append content OUTSIDE Mort's region.
    const humanEdited = doc.text + "\n\n## Human addendum\n\nAdded by a person after Mort.";
    await updateDocument({ id, title: doc.title, text: humanEdited, publish: true });

    // 3. Mort updates his region again.
    await setRegion(id, "Zone: Main Stage\n\nSystem: Lighting\n\n## Mort notes\n\nv2 content");
    doc = await getDocument(id);
    check("original human content still present", doc.text.includes("DO NOT let a bot rewrite this"));
    check("later human addendum still present", doc.text.includes("Added by a person after Mort"));
    check("Mort region updated to v2", (extractMortRegion(doc.text) ?? "").includes("v2 content"));
    check("old v1 region content gone", !doc.text.includes("v1 content"));
    check("exactly one Mort region", doc.text.split("<!-- mort:start -->").length - 1 === 1);

    console.log("\n--- final doc text ---\n" + doc.text + "\n----------------------");
  } finally {
    await deleteDocument(id);
    console.log(`\nDeleted smoke doc ${id}.`);
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

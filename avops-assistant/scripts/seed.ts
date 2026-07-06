/**
 * Seed the vector store with the sample KB docs (`sample_kb/` in the repo
 * root) so the app is demoable without a live Outline (brief §12).
 *
 * Usage: pnpm seed   (reads .env; needs VOYAGE_API_KEY + QDRANT_URL, and
 * DATABASE_URL for best-effort kb_documents bookkeeping)
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "../src/lib/rag/chunker";
import { embedBatch } from "../src/lib/rag/embeddings";
import { parseMetadataBlock } from "../src/lib/rag/metadata";
import {
  countPoints,
  deleteDocPoints,
  ensureCollection,
  upsertChunks,
} from "../src/lib/rag/store";

async function findSampleKbDir(): Promise<string> {
  for (const candidate of ["../sample_kb", "./sample_kb"]) {
    const dir = path.resolve(process.cwd(), candidate);
    try {
      await readdir(dir);
      return dir;
    } catch {
      // try next
    }
  }
  throw new Error("sample_kb/ directory not found (looked in repo root and cwd)");
}

async function main() {
  const dir = await findSampleKbDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  if (files.length === 0) throw new Error(`No .md files in ${dir}`);

  await ensureCollection();
  const outlineBase = (process.env.OUTLINE_URL ?? "http://localhost:3000").replace(/\/$/, "");

  let totalChunks = 0;
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8");
    const { metadata, body } = parseMetadataBlock(raw);
    const slug = file.replace(/\.md$/, "");
    const title =
      body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug.replace(/-/g, " ");
    const docId = `sample:${slug}`;
    const url = `${outlineBase}/doc/${slug}`;

    const chunks = chunkMarkdown(title, body);
    const vectors = await embedBatch(chunks.map((c) => c.text), "document");

    await deleteDocPoints(docId);
    await upsertChunks(
      chunks.map((chunk, i) => ({
        vector: vectors[i],
        payload: {
          text: chunk.text,
          breadcrumb: chunk.breadcrumb,
          docId,
          title,
          url,
          category: "Sample KB",
          zone: metadata.zone,
          system: metadata.system,
          docType: metadata.docType,
        },
      })),
    );

    // Best-effort bookkeeping so the admin page reflects the seed.
    try {
      const { db, kbDocuments } = await import("../src/lib/db");
      await db
        .insert(kbDocuments)
        .values({
          outlineId: docId,
          title,
          collectionName: "Sample KB",
          url,
          chunkCount: chunks.length,
          status: "synced",
        })
        .onConflictDoUpdate({
          target: kbDocuments.outlineId,
          set: { chunkCount: chunks.length, status: "synced", syncedAt: new Date() },
        });
    } catch {
      console.warn(`  (kb_documents bookkeeping skipped — database unreachable)`);
    }

    totalChunks += chunks.length;
    console.log(`✓ ${file}: "${title}" → ${chunks.length} chunks`);
  }

  console.log(`Seeded ${files.length} docs, ${totalChunks} chunks. Qdrant total: ${await countPoints()} points.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err.message ?? err);
  process.exit(1);
});

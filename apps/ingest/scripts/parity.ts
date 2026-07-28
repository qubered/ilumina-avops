import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { getEffectiveMode } from "@mort/core/memory/config";
import { getBlob, listLibrary } from "@mort/core/memory";
import { ensureMortSchema } from "@mort/core/memory/schema";
import { classifyRole } from "../src/mort/classify.js";
import { extract } from "../src/extract.js";
import { runMortAgentTurn } from "../src/mort/agent-turn.js";
import { buildTurnDeps } from "../src/mort/deps.js";
import { runMortTurn, type TurnDeps, type TurnFile, type TurnOutcome } from "../src/mort/turn.js";
import { getEffectiveThreshold } from "@mort/core/memory/config";

/**
 * The parity harness (v2/P6 acceptance).
 *
 * Both engines decide about the same files, side by side, and the decisions are
 * diffed. Nothing is written by either: the write executors are replaced with
 * recorders, so `createDoc` returns a fake id instead of making a page and
 * `enqueueReview` counts instead of queueing. Reads are real — the KB search,
 * the Outline page bodies and Mort's library all come from the live stack,
 * because retrieval is most of what the two engines disagree about and faking
 * it would test nothing.
 *
 * The point is not that the two agree on everything. It's that where they
 * differ, someone has looked at the difference and decided the new one is at
 * least as good — which is what "diff the decisions before cutting over" means.
 *
 *   pnpm --filter ingest parity -- --dir ../../sample_kb
 *   pnpm --filter ingest parity -- --library --limit 25 --json parity.json
 */

type Args = { dir?: string; library: boolean; limit: number; json?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { library: false, limit: 25 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--library") args.library = true;
    else if (argv[i] === "--limit") args.limit = Math.max(1, Number(argv[++i]) || 25);
    else if (argv[i] === "--json") args.json = argv[++i];
  }
  return args;
}

type Candidate = { sourceId: string; fileName: string; folderPath?: string; contentType: string; data: Buffer };

/** Files from a directory on disk — the usual way to run this before a cutover. */
async function fromDir(dir: string, limit: number): Promise<{ files: Candidate[]; skipped: string[] }> {
  const root = resolve(dir);
  const files: Candidate[] = [];
  const skipped: string[] = [];

  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (files.length >= limit) {
        skipped.push(relative(root, full));
        continue;
      }
      const rel = relative(root, full);
      const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : undefined;
      files.push({
        sourceId: `parity/${rel}`,
        fileName: basename(full),
        folderPath: folder,
        contentType: "application/octet-stream",
        data: await readFile(full),
      });
    }
  };
  await walk(root);
  return { files, skipped };
}

/** Files Mort already holds bytes for — a replay of real history, where it exists. */
async function fromLibrary(limit: number): Promise<{ files: Candidate[]; skipped: string[] }> {
  const library = await listLibrary();
  const files: Candidate[] = [];
  const skipped: string[] = [];
  for (const entry of library) {
    if (!entry.hasBytes) {
      // Only reference/media bytes are kept; a Word document's are not, so most
      // history simply cannot be replayed this way. Say so rather than quietly
      // reporting parity over a biased sample — use --dir for the rest.
      skipped.push(`${entry.sourceId} (no stored bytes — only reference/media are kept)`);
      continue;
    }
    if (files.length >= limit) {
      skipped.push(`${entry.sourceId} (over --limit)`);
      continue;
    }
    const blob = await getBlob(entry.sourceId);
    if (!blob) {
      skipped.push(`${entry.sourceId} (bytes gone since the library was read)`);
      continue;
    }
    const slash = entry.sourceId.lastIndexOf("/");
    files.push({
      sourceId: entry.sourceId,
      fileName: blob.fileName,
      folderPath: slash > 0 ? entry.sourceId.slice(0, slash) : undefined,
      contentType: blob.contentType,
      data: blob.data,
    });
  }
  return { files, skipped };
}

/** Write executors replaced by recorders. Reads stay real. */
function dryRunDeps(): { deps: TurnDeps; writes: string[] } {
  const writes: string[] = [];
  const real = buildTurnDeps(null);
  return {
    writes,
    deps: {
      ...real,
      createDoc: async (a) => {
        writes.push(`create "${a.title}"`);
        return "dry-run-doc";
      },
      updateRegion: async (docId) => {
        writes.push(`update ${docId}`);
      },
      attachFile: async (docId) => {
        writes.push(`attach → ${docId}`);
      },
      enqueueReview: async (item) => {
        writes.push(`review ${item.action}`);
        return true;
      },
      journal: async () => {},
    },
  };
}

type Verdict = { decided: string; executed: string; docId: string | null; error?: string };

type Row = {
  sourceId: string;
  pipeline: Verdict;
  agent: Verdict;
  sameAction: boolean;
  sameTarget: boolean;
};

const summarise = (o: TurnOutcome): Verdict => ({ decided: o.decided, executed: o.executed, docId: o.docId ?? null });
const failed = (err: unknown): Verdict => ({
  decided: "ERROR",
  executed: "ERROR",
  docId: null,
  error: err instanceof Error ? err.message : String(err),
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir && !args.library) {
    console.error("Usage: parity --dir <path> | --library [--limit N] [--json <file>]");
    process.exit(2);
  }

  await ensureMortSchema();
  const mode = await getEffectiveMode();
  const threshold = await getEffectiveThreshold();
  console.log(
    `[parity] mode=${mode} threshold=${threshold} — neither engine will write a page or queue a review.\n` +
      `[parity] Real model calls, so: tokens count against the daily cap, and the agent's calls land in\n` +
      `[parity] mort_tool_calls as they would in production. A turn the cap stops shows up as HOLD.\n`,
  );

  const { files, skipped } = args.dir ? await fromDir(args.dir, args.limit) : await fromLibrary(args.limit);
  if (!files.length) {
    console.error("[parity] nothing to compare.");
    for (const s of skipped) console.error(`  skipped: ${s}`);
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const file of files) {
    const extraction = await extract(file.fileName, file.contentType, file.data);
    const role = classifyRole({
      fileName: file.fileName,
      contentType: file.contentType,
      folderPath: file.folderPath,
      extraction: { kind: extraction.kind, text: extraction.markdown },
    });
    const turnFile: TurnFile = {
      sourceId: file.sourceId,
      fileName: file.fileName,
      folderPath: file.folderPath,
      contentType: file.contentType,
      extractedMarkdown: extraction.markdown,
      extractionKind: extraction.kind,
    };

    // Fresh recorders per engine so one can't see the other's writes.
    const a = dryRunDeps();
    const b = dryRunDeps();
    const pipeline = await runMortTurn(turnFile, { mode: mode === "live" ? "live" : "shadow", confidenceThreshold: threshold }, a.deps)
      .then(summarise)
      .catch(failed);
    const agent = await runMortAgentTurn(turnFile, role, b.deps).then(summarise).catch(failed);

    const row: Row = {
      sourceId: file.sourceId,
      pipeline,
      agent,
      sameAction: pipeline.decided === agent.decided,
      sameTarget: pipeline.docId === agent.docId,
    };
    rows.push(row);
    console.log(
      `${row.sameAction ? "  =" : "  ≠"} ${file.sourceId}\n` +
        `      pipeline: ${pipeline.decided} → ${pipeline.executed}${pipeline.docId ? ` (${pipeline.docId})` : ""}${pipeline.error ? ` [${pipeline.error}]` : ""}\n` +
        `      agent:    ${agent.decided} → ${agent.executed}${agent.docId ? ` (${agent.docId})` : ""}${agent.error ? ` [${agent.error}]` : ""}`,
    );
  }

  const agreed = rows.filter((r) => r.sameAction).length;
  const errored = rows.filter((r) => r.pipeline.error || r.agent.error).length;
  console.log(
    `\n[parity] ${agreed}/${rows.length} same action (${Math.round((agreed / rows.length) * 100)}%)` +
      `, ${rows.filter((r) => r.sameAction && r.sameTarget).length} same action AND target` +
      (errored ? `, ${errored} errored` : ""),
  );
  if (skipped.length) {
    // Never let a truncated run read as full coverage.
    console.log(`[parity] ${skipped.length} file(s) not compared:`);
    for (const s of skipped.slice(0, 20)) console.log(`  - ${s}`);
    if (skipped.length > 20) console.log(`  … and ${skipped.length - 20} more`);
  }
  console.log(
    `\n[parity] Disagreement is not failure — read each one and decide whether the agent's call is at least as` +
      `\n         good. Once it is, flip the engine: mort_settings.ingest_engine = 'agent' (admin console).`,
  );

  if (args.json) {
    await writeFile(args.json, JSON.stringify({ mode, threshold, rows, skipped }, null, 2));
    console.log(`[parity] wrote ${args.json}`);
  }
  process.exit(0);
}

void main().catch((err) => {
  console.error("[parity] failed:", err);
  process.exit(1);
});

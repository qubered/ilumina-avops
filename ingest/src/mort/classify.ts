import type { FileRole } from "./types.js";

/**
 * File-role classifier (MORT_PLAN §v1.3). Deterministic first pass from
 * filename / type / folder — decides how Mort treats a file (see the
 * source-of-truth hierarchy in identity.ts). The LLM decision refines *what to
 * do*; this decides *what kind of thing it is*.
 */

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

const WORD = new Set(["docx", "doc", "rtf", "odt"]);
const TEXT = new Set(["txt", "md", "markdown"]);
const SHEET = new Set(["xlsx", "xls", "csv", "ods"]);
const MEDIA = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp", "tiff", "mp4", "mov", "wav", "mp3", "aiff"]);
const SLIDES = new Set(["pptx", "ppt", "key", "odp"]);
// Lighting / console / AV show + config files → attach, never transcribe.
const REFERENCE = new Set(["show", "gz", "shw", "mvr", "gdtf", "qxw", "qxd", "vwx", "lac", "d3", "wsm", "avc", "cas", "mldc", "ma", "isf", "zip"]);

/** Substrings (in filename or folder) that designate the events/actions log. */
const EVENT_LOG_HINTS = (process.env.MORT_EVENT_LOG_MATCH ?? "events,actions,activity log,work log")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function looksLikeEventLog(fileName: string, folderPath?: string): boolean {
  const hay = `${folderPath ?? ""}/${fileName}`.toLowerCase();
  return EVENT_LOG_HINTS.some((h) => hay.includes(h));
}

export function classifyRole(input: { fileName: string; contentType?: string; folderPath?: string }): FileRole {
  const e = ext(input.fileName);
  const ct = (input.contentType ?? "").toLowerCase();

  // Event log (R1) — a designated spreadsheet of actions. Detected here; special
  // handling ships in R1. Must win over the generic 'structured' sheet rule.
  if ((SHEET.has(e) || ct.includes("spreadsheet") || ct.includes("excel") || ct === "text/csv") && looksLikeEventLog(input.fileName, input.folderPath)) {
    return "event_log";
  }

  if (WORD.has(e) || ct.includes("wordprocessingml") || ct === "application/msword") return "truth";
  if (TEXT.has(e) || ct.startsWith("text/")) return "truth";
  if (e === "pdf" || ct.includes("pdf")) return "truth"; // usually documented procedures
  if (SHEET.has(e) || ct.includes("spreadsheet") || ct.includes("excel")) return "structured";
  if (MEDIA.has(e) || ct.startsWith("image/") || ct.startsWith("video/") || ct.startsWith("audio/")) return "media";
  if (SLIDES.has(e) || ct.includes("presentationml")) return "reference";
  if (REFERENCE.has(e) || ct === "application/octet-stream") return "reference";

  // Unknown → treat as a reference artifact (attach, don't transcribe) — the
  // safe default per the source-of-truth hierarchy.
  return e ? "reference" : "unknown";
}

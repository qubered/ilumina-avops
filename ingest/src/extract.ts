import mammoth from "mammoth";
import TurndownService from "turndown";
import * as XLSX from "xlsx";
import { extractText } from "unpdf";
import { parseOffice } from "officeparser";

/**
 * Turn a raw file into markdown + the images it contains. Images carry an
 * `attachment://<i>` token that appears in the markdown; the caller uploads
 * each to Outline and swaps the token for the real attachment URL.
 */
export type ExtractedImage = {
  token: string;
  name: string;
  contentType: string;
  data: Buffer;
};

export type Extraction = {
  kind: "docx" | "pdf" | "spreadsheet" | "pptx" | "image" | "text";
  markdown: string;
  images: ExtractedImage[];
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function ext(fileName: string): string {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

async function fromDocx(buffer: Buffer): Promise<Extraction> {
  const images: ExtractedImage[] = [];
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const b64 = await image.read("base64");
        const contentType = image.contentType || "image/png";
        const extension = (contentType.split("/")[1] || "png").replace("jpeg", "jpg");
        const token = `attachment://${images.length}`;
        images.push({
          token,
          name: `image-${images.length + 1}.${extension}`,
          contentType,
          data: Buffer.from(b64, "base64"),
        });
        return { src: token };
      }),
    },
  );
  return { kind: "docx", markdown: turndown.turndown(result.value), images };
}

async function fromPdf(buffer: Buffer): Promise<Extraction> {
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
  return { kind: "pdf", markdown: Array.isArray(text) ? text.join("\n\n") : text, images: [] };
}

function fromSpreadsheet(buffer: Buffer): Extraction {
  const wb = XLSX.read(buffer, { type: "buffer" });
  let md = "";
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
      header: 1,
      blankrows: false,
      defval: "",
    });
    if (rows.length === 0) continue;
    if (wb.SheetNames.length > 1) md += `## ${name}\n\n`;
    const header = rows[0];
    md += `| ${header.map((c) => String(c ?? "")).join(" | ")} |\n`;
    md += `| ${header.map(() => "---").join(" | ")} |\n`;
    for (const row of rows.slice(1)) {
      md += `| ${header.map((_, i) => String(row[i] ?? "").replace(/\|/g, "\\|")).join(" | ")} |\n`;
    }
    md += "\n";
  }
  return { kind: "spreadsheet", markdown: md.trim(), images: [] };
}

async function fromPptx(buffer: Buffer): Promise<Extraction> {
  const ast = await parseOffice(buffer);
  const text = ast.toText();
  return { kind: "pptx", markdown: text, images: [] };
}

function fromImage(buffer: Buffer, fileName: string, contentType: string): Extraction {
  const token = "attachment://0";
  return {
    kind: "image",
    markdown: `![${fileName}](${token})`,
    images: [{ token, name: fileName, contentType, data: buffer }],
  };
}

export async function extract(
  fileName: string,
  contentType: string,
  buffer: Buffer,
): Promise<Extraction> {
  const e = ext(fileName);
  const ct = contentType.toLowerCase();

  if (e === "docx" || ct.includes("wordprocessingml")) return fromDocx(buffer);
  if (e === "pdf" || ct.includes("pdf")) return fromPdf(buffer);
  if (["xlsx", "xls", "csv"].includes(e) || ct.includes("spreadsheet") || ct.includes("excel") || ct === "text/csv")
    return fromSpreadsheet(buffer);
  if (e === "pptx" || ct.includes("presentationml")) return fromPptx(buffer);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e) || ct.startsWith("image/"))
    return fromImage(buffer, fileName, contentType || "image/png");
  if (["txt", "md", "markdown"].includes(e) || ct.startsWith("text/"))
    return { kind: "text", markdown: buffer.toString("utf8"), images: [] };

  // Last resort: let officeparser try, else treat as UTF-8 text.
  try {
    const ast = await parseOffice(buffer);
  const text = ast.toText();
    return { kind: "text", markdown: text, images: [] };
  } catch {
    return { kind: "text", markdown: buffer.toString("utf8"), images: [] };
  }
}

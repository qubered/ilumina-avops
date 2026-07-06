import { describe, expect, it } from "vitest";
import { rewriteAttachmentUrls } from "./attachments";

const ID = "0198f2be-58f4-7aaa-bbbb-cccccccccccc";

describe("rewriteAttachmentUrls", () => {
  it("rewrites relative attachment images to the app proxy", () => {
    const md = `Before\n\n![patch bay](/api/attachments.redirect?id=${ID})\n\nAfter`;
    expect(rewriteAttachmentUrls(md)).toContain(`![patch bay](/api/kb/attachment?id=${ID})`);
  });

  it("rewrites absolute attachment URLs and file links", () => {
    const md = `[show file.pdf](https://kb.venue.example/api/attachments.redirect?id=${ID}&size=full)`;
    expect(rewriteAttachmentUrls(md)).toBe(`[show file.pdf](/api/kb/attachment?id=${ID})`);
  });

  it("leaves normal links and images alone", () => {
    const md = "![logo](https://example.com/logo.png) and [doc](/doc/some-page)";
    expect(rewriteAttachmentUrls(md)).toBe(md);
  });
});

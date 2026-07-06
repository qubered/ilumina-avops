/**
 * Outline embeds document attachments (images, PDFs, files) as relative,
 * auth-protected URLs: `/api/attachments.redirect?id=<uuid>`.
 *
 * At sync time those are rewritten to this app's authenticated proxy
 * (`/api/kb/attachment?id=<uuid>`), so when the model quotes a KB chunk that
 * contains an image or file link, it renders/downloads for any signed-in
 * crew member — the proxy fetches from Outline with the bot API key.
 */

const ATTACHMENT_URL_RE =
  /\((?:https?:\/\/[^\s)]+)?\/api\/attachments\.redirect\?id=([0-9a-f-]{36})[^\s)]*\)/gi;

export function rewriteAttachmentUrls(markdown: string): string {
  return markdown.replace(ATTACHMENT_URL_RE, "(/api/kb/attachment?id=$1)");
}

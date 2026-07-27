import { eq } from "drizzle-orm";
import { getDb } from "./index";
import { oauthApplication } from "./schema";
import { getEnv } from "../env";

/**
 * Mirror the trusted Outline OIDC client (configured via env) into
 * oauth_application. The trusted-client config drives authorization and
 * consent-skipping, but oauth_access_token.client_id has a foreign key to
 * this table, so the row must exist for token persistence.
 */
export async function ensureOidcClientRow(): Promise<void> {
  const env = getEnv();
  if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return;

  const db = getDb();
  const redirectUrls = `${env.OUTLINE_URL.replace(/\/$/, "")}/auth/oidc.callback`;
  const now = new Date();

  const [existing] = await db
    .select({ id: oauthApplication.id })
    .from(oauthApplication)
    .where(eq(oauthApplication.clientId, env.OIDC_CLIENT_ID))
    .limit(1);

  if (existing) {
    await db
      .update(oauthApplication)
      .set({ clientSecret: env.OIDC_CLIENT_SECRET, redirectUrls, updatedAt: now })
      .where(eq(oauthApplication.clientId, env.OIDC_CLIENT_ID));
  } else {
    await db.insert(oauthApplication).values({
      id: crypto.randomUUID(),
      name: "Outline Wiki",
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUrls,
      type: "web",
      disabled: false,
      createdAt: now,
      updatedAt: now,
    });
  }
  console.log("[auth] Outline OIDC client registered");
}

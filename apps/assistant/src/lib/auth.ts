import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, oidcProvider } from "better-auth/plugins";
import { timingSafeEqual } from "node:crypto";
import { count } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "./db";
import * as schema from "./db/schema";
import { getEnv } from "./env";

function createAuth() {
  const env = getEnv();

  // Outline is registered as a trusted OIDC client so this app acts as the
  // SSO identity provider for the wiki: one account for both apps.
  const outlineOidcClient =
    env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
      ? [
          {
            clientId: env.OIDC_CLIENT_ID,
            clientSecret: env.OIDC_CLIENT_SECRET,
            name: "Outline Wiki",
            type: "web" as const,
            redirectUrls: [`${env.OUTLINE_URL.replace(/\/$/, "")}/auth/oidc.callback`],
            disabled: false,
            skipConsent: true, // same org, same crew — no consent screen
            metadata: null,
          },
        ]
      : [];

  return betterAuth({
  appName: "ILUMINA AV Ops",
  baseURL: env.APP_URL,
  secret: env.AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },
  // user.role is owned by the admin plugin (defaultRole "member").
  hooks: {
    // Registration gate: when SIGNUP_KEY is set, sign-up requires it
    // (sent as the x-signup-key header by the register form).
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email" || !env.SIGNUP_KEY) return;
      const provided = ctx.headers?.get("x-signup-key") ?? "";
      const a = Buffer.from(provided);
      const b = Buffer.from(env.SIGNUP_KEY);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new APIError("FORBIDDEN", {
          message: "Invalid signup key. Ask the AV lead for the crew invite code.",
        });
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // First registered user becomes admin (per spec).
          const [{ value }] = await db
            .select({ value: count() })
            .from(schema.user);
          return { data: { ...user, role: value === 0 ? "admin" : "member" } };
        },
      },
    },
  },
  rateLimit: {
    // In-memory limiter, always on (better-auth applies stricter built-in
    // rules to sign-in/sign-up paths).
    enabled: true,
    window: 60,
    max: 30,
  },
  advanced: env.COOKIE_DOMAIN
    ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: env.COOKIE_DOMAIN,
        },
        defaultCookieAttributes: {
          sameSite: "none",
          secure: true,
          httpOnly: true,
        },
      }
    : undefined,
  trustedOrigins: [env.OUTLINE_URL],
  plugins: [
    // User management for the admin page: list/set-role/ban/remove, with
    // authorization enforced on the server for role "admin".
    admin({ adminRoles: ["admin"], defaultRole: "member" }),
    oidcProvider({
      loginPage: "/login",
      trustedClients: outlineOidcClient,
      allowDynamicClientRegistration: false,
      scopes: ["openid", "profile", "email"],
      getAdditionalUserInfoClaim: (user) => ({
        // Outline reads `preferred_username` by default (OIDC_USERNAME_CLAIM).
        preferred_username: user.email,
        role: (user as { role?: string }).role ?? "member",
      }),
    }),
    // Must be last: applies Set-Cookie headers in Next.js server actions.
    nextCookies(),
  ],
  });
}

type Auth = ReturnType<typeof createAuth>;

let cachedAuth: Auth | null = null;

/** Lazy singleton so importing this module never requires env (build-time). */
export function getAuth(): Auth {
  if (!cachedAuth) cachedAuth = createAuth();
  return cachedAuth;
}

export const auth: Auth = new Proxy({} as Auth, {
  get(_target, prop) {
    const real = getAuth() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(getAuth()) : value;
  },
});

export type Session = Auth["$Infer"]["Session"];

/** Session for the current request in a route handler / RSC; null → 401. */
export async function requireSession(): Promise<Session | null> {
  // headers() first: during prerender it bails out to dynamic rendering
  // before the lazy auth/env initialization runs.
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user?.id) return null;
  return session as Session;
}

/** Admin-only guard; null → 401/403. */
export async function requireAdmin(): Promise<Session | null> {
  const session = await requireSession();
  if (!session || session.user.role !== "admin") return null;
  return session;
}

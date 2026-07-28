import type { ActingUser } from "@mort/core/agent";
import type { Session } from "./auth";

/**
 * The one place an acting user is minted, and it takes exactly one argument:
 * the session. Attribution on a taught fact is the whole reason it may outrank
 * the KB, so it is never assembled from a request body — same rule v1 applied
 * to `approvedBy`, now applied everywhere Mort writes on someone's say-so.
 */
export function actingUserFromSession(session: Session): ActingUser {
  const user = session.user as { id: string; email?: string | null; name?: string | null; role?: string | null };
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    role: user.role === "admin" ? "admin" : "member",
  };
}

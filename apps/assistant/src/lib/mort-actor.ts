import type { ActingUser } from "@mort/core/tools/policy";
import type { Session } from "./auth";

/**
 * The acting user for a Mort turn or a confirmation, derived from the SESSION
 * and nothing else.
 *
 * This is the v1 `approvedBy` rule generalised (MORT_V2_PLAN §I.4): attribution
 * never comes from the request body and never from the model. Every route that
 * can cause a write funnels through here, so there is exactly one place that
 * decides "who is doing this", and it reads a cookie-backed session.
 */
export function actingUser(session: Session): ActingUser {
  return {
    id: session.user.id,
    // Email where we have one — a journal entry saying "confirmed by
    // 3f2a…" helps nobody six months later.
    label: session.user.email ?? session.user.name ?? session.user.id,
    role: session.user.role === "admin" ? "admin" : "member",
  };
}

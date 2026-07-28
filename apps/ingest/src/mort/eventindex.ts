/**
 * Event indexing moved into core (`@mort/core/kb/events-index`) when chat
 * gained the ability to log events: both entry points now push rows through
 * exactly the same embed → upsert → prune path. Re-exported here so the
 * ingest call sites keep their local import.
 */
export { indexEvents } from "@mort/core/kb/events-index";

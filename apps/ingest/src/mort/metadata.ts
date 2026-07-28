/**
 * The article metadata header moved into mort-core (v2/P3) so chat-authored
 * pages carry the same header as ingested ones. This file stays as the ingest
 * pipeline's import point — its tests and call sites are unchanged.
 */
export { renderMetadataHeader, roleToTier, type MortMeta } from "@mort/core/kb/mort-header";

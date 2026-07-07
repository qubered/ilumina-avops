import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// Better Auth owns users/sessions/accounts + OIDC provider tables.
export * from "./auth-schema";

export type Source = { title: string; url: string; kind?: "kb" | "web" };

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    // The widget uses a single rolling conversation per user.
    isWidget: boolean("is_widget").notNull().default(false),
    // Resumable-stream id while an answer is being generated (null when idle).
    activeStreamId: text("active_stream_id"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    sources: jsonb("sources").$type<Source[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    rating: text("rating", { enum: ["up", "down"] }).notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("feedback_message_user_idx").on(t.messageId, t.userId)],
);

export const kbDocuments = pgTable("kb_documents", {
  outlineId: text("outline_id").primaryKey(),
  title: text("title").notNull(),
  collectionName: text("collection_name").notNull().default(""),
  url: text("url").notNull(),
  lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
  chunkCount: integer("chunk_count").notNull().default(0),
  status: text("status", { enum: ["synced", "error"] })
    .notNull()
    .default("synced"),
  errorMessage: text("error_message"),
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  docCount: integer("doc_count").notNull().default(0),
  chunkCount: integer("chunk_count").notNull().default(0),
  trigger: text("trigger", { enum: ["manual", "cron", "webhook"] }).notNull(),
  status: text("status", { enum: ["running", "success", "error"] })
    .notNull()
    .default("running"),
  errorMessage: text("error_message"),
});

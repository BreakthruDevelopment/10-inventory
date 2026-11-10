import { sql } from "drizzle-orm";
import { bigserial, boolean, char, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Tenancy: workspaces, memberships and invites. Every inventory row (item, stock_movement, ... added by later
// issues) carries `workspace_id`; access is decided by `requireMember()` in src/lib/tenancy.ts, never by a
// per-user owner column. Global roles (`user`, `admin`) stay as they are; `admin` gets counts only.
// ---------------------------------------------------------------------------

export const MEMBER_ROLES = ["manager", "staff"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    /** Who created it, for the per-user cap. Nulled when that account is deleted; membership decides access. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workspace_created_by_idx").on(t.createdBy),
    check("workspace_name_chk", sql`char_length(${t.name}) between 1 and 80`),
  ],
);

export const membership = pgTable(
  "membership",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("membership_user_idx").on(t.userId),
    check("membership_role_chk", sql`${t.role} in ('manager', 'staff')`),
  ],
);

/** Only the SHA-256 of the token is stored (the 32-byte token itself is shown once, in the link). */
export const invite = pgTable(
  "invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedBy: text("used_by").references(() => user.id, { onDelete: "set null" }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invite_workspace_created_idx").on(t.workspaceId, t.createdAt),
    check("invite_role_chk", sql`${t.role} in ('manager', 'staff')`),
  ],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["api_write", "movement", "invite", "export", "ai", "demo_load"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). `payload` holds ids and small parameters, never personal data or secrets. `last_error` is a short
 * code, never a message.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

export type User = typeof user.$inferSelect;
export type Workspace = typeof workspace.$inferSelect;
export type Membership = typeof membership.$inferSelect;
export type Invite = typeof invite.$inferSelect;
export type Job = typeof job.$inferSelect;

// Inventory balances and the immutable ledger. Stock and version change in the same transaction as its movement.
export const ITEM_UNITS = ["each", "case", "kg", "l"] as const;
export const MOVEMENT_KINDS = ["receive", "sale", "adjust", "count"] as const;
export const item = pgTable("item", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspace.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  barcode: text("barcode"),
  unit: text("unit", { enum: ITEM_UNITS }).notNull().default("each"),
  onHand: integer("on_hand").notNull().default(0),
  reorderPoint: integer("reorder_point").notNull().default(0),
  leadTimeDays: integer("lead_time_days").notNull().default(0),
  packSize: integer("pack_size").notNull().default(1),
  supplierName: text("supplier_name").notNull().default(""),
  unitCostCents: integer("unit_cost_cents").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("item_id_workspace_uidx").on(t.id, t.workspaceId),
  uniqueIndex("item_workspace_sku_uidx").on(t.workspaceId, t.sku),
  uniqueIndex("item_workspace_barcode_uidx").on(t.workspaceId, t.barcode).where(sql`${t.barcode} is not null`),
  check("item_balance_chk", sql`${t.onHand} >= 0 and ${t.version} >= 1`),
  check("item_fields_chk", sql`char_length(${t.sku}) between 1 and 40 and char_length(${t.name}) between 1 and 120 and (${t.barcode} is null or char_length(${t.barcode}) between 4 and 64) and char_length(${t.supplierName}) <= 120`),
  check("item_unit_chk", sql`${t.unit} in ('each', 'case', 'kg', 'l')`),
  check("item_reorder_chk", sql`${t.reorderPoint} between 0 and 100000 and ${t.leadTimeDays} between 0 and 90 and ${t.packSize} between 1 and 10000 and ${t.unitCostCents} >= 0`),
]);

export const stockMovement = pgTable("stock_movement", {
  // Strings avoid losing precision when bigint ids are serialized as JSON.
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspace.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull(),
  kind: text("kind", { enum: MOVEMENT_KINDS }).notNull(),
  delta: integer("delta").notNull(),
  onHandAfter: integer("on_hand_after").notNull(),
  itemVersion: integer("item_version").notNull(),
  reason: text("reason").notNull().default(""),
  // Retain the opaque audit id when an account is removed; an FK SET NULL would mutate the ledger.
  actorId: text("actor_id").notNull(),
  clientOpId: uuid("client_op_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.itemId, t.workspaceId], foreignColumns: [item.id, item.workspaceId] }).onDelete("cascade"),
  uniqueIndex("stock_movement_workspace_op_uidx").on(t.workspaceId, t.clientOpId),
  index("stock_movement_workspace_item_created_idx").on(t.workspaceId, t.itemId, t.createdAt),
  check("stock_movement_kind_chk", sql`${t.kind} in ('receive', 'sale', 'adjust', 'count')`),
  check("stock_movement_values_chk", sql`${t.onHandAfter} >= 0 and ${t.itemVersion} >= 2 and char_length(${t.reason}) <= 200 and (${t.kind} <> 'receive' or ${t.delta} > 0) and (${t.kind} <> 'sale' or ${t.delta} < 0) and (${t.kind} <> 'adjust' or (${t.delta} <> 0 and char_length(${t.reason}) > 0))`),
]);
export type Item = typeof item.$inferSelect;
export type StockMovement = typeof stockMovement.$inferSelect;

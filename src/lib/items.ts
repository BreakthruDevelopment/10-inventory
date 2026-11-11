import "server-only";
import { and, count, desc, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { barcodeInput, lookupCodeInput } from "@/lib/barcodes";
import { db, schema } from "@/lib/db";
import { ITEM_UNITS, type StockMovement } from "@/lib/db/schema";
import { ConflictError, NotFoundError, StockConflictError } from "@/lib/errors";
import { requireMember } from "@/lib/tenancy";
import { advisoryLock, consumeRate, type Tx } from "@/lib/usage";

const { item, stockMovement } = schema;
const CONFLICT_MOVEMENTS = 50;
const int = (min: number, max = 2147483647) => z.number().int().min(min).max(max);
const fields = {
  sku: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120),
  barcode: barcodeInput.nullable().default(null), unit: z.enum(ITEM_UNITS).default("each"),
  reorderPoint: int(0, 100000).default(0), leadTimeDays: int(0, 90).default(0),
  packSize: int(1, 10000).default(1), supplierName: z.string().trim().max(120).default(""),
  unitCostCents: int(0).default(0),
};
export const newItemInput = z.object(fields).strict();
export const editItemInput = z.object({
  sku: fields.sku.optional(), name: fields.name.optional(), barcode: barcodeInput.nullable().optional(),
  unit: z.enum(ITEM_UNITS).optional(), reorderPoint: int(0, 100000).optional(),
  leadTimeDays: int(0, 90).optional(), packSize: int(1, 10000).optional(),
  supplierName: z.string().trim().max(120).optional(), unitCostCents: int(0).optional(), version: int(1),
}).strict().refine(d => Object.entries(d).some(([k, v]) => k !== "version" && v !== undefined), "Send at least one field to change.");
export const archiveItemInput = z.object({ version: int(1) }).strict();
export const listItemsInput = z.object({ q: z.string().trim().max(120).default(""), archived: z.enum(["true", "false"]).default("false") }).strict();

export const movementView = (row: StockMovement) => ({ ...row, id: row.id.toString() });
const idInput = (id: string) => {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
};
export const itemScope = (workspaceId: string, itemId: string) => and(eq(item.workspaceId, workspaceId), eq(item.id, idInput(itemId)));

/** A locked snapshot keeps the conflict's current version and movement list consistent. */
export async function stockConflict(tx: Tx, workspaceId: string, itemId: string, sinceVersion = 0, delta?: number): Promise<never> {
  const [current] = await tx.select().from(item).where(itemScope(workspaceId, itemId)).for("share");
  if (!current) throw new NotFoundError();
  // Only the newest page: an item can have thousands of movements and the body goes to the client.
  const newest = await tx.select().from(stockMovement).where(and(
    eq(stockMovement.workspaceId, workspaceId), eq(stockMovement.itemId, itemId), gt(stockMovement.itemVersion, sinceVersion),
  )).orderBy(desc(stockMovement.itemVersion)).limit(CONFLICT_MOVEMENTS + 1);
  const truncated = newest.length > CONFLICT_MOVEMENTS;
  const movements = newest.slice(0, CONFLICT_MOVEMENTS).reverse();
  const message = current.archivedAt ? "This item is archived." : delta !== undefined
    ? delta > 0 ? "Stock cannot exceed 2,147,483,647." : `Only ${current.onHand} left`
    : "This item changed. Review the current stock and recount or explicitly keep yours.";
  throw new StockConflictError(message, current, movements.map(movementView), truncated);
}

/**
 * Run a write that may end in a stock conflict. The conflict rolls the transaction back, rate event included,
 * so record the attempt in its own short transaction afterwards; rejected attempts still count.
 */
export async function countConflicts<T>(actorId: string, kind: "api_write" | "movement", limit: number, message: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (err) {
    if (err instanceof StockConflictError) await db().transaction(tx => consumeRate(tx, actorId, kind, limit, message));
    throw err;
  }
}

/** Map only the known SKU/barcode constraints, never include query parameters in errors. */
export function inventoryError(err: unknown): never {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const p = e as { code?: string; constraint_name?: string; constraint?: string };
    if (p.code === "23505" && ["item_workspace_sku_uidx", "item_workspace_barcode_uidx"].includes(p.constraint_name ?? p.constraint ?? "")) {
      throw new ConflictError("That SKU or barcode is already in this workspace.");
    }
  }
  throw err;
}

export async function listItems(actor: { id: string }, workspaceId: string, input: unknown = {}) {
  const member = await requireMember(actor, workspaceId);
  const { q, archived } = listItemsInput.parse(input);
  const escaped = q.replace(/[\\%_]/g, "\\$&");
  return db().select().from(item).where(and(eq(item.workspaceId, member.workspaceId),
    archived === "true" ? undefined : isNull(item.archivedAt),
    q ? or(ilike(item.name, `%${escaped}%`), ilike(item.sku, `%${escaped}%`), ilike(item.barcode, `%${escaped}%`)) : undefined,
  )).orderBy(item.name, item.id).limit(2000);
}

export async function getItem(actor: { id: string }, workspaceId: string, itemId: string) {
  const member = await requireMember(actor, workspaceId);
  // One statement/snapshot for balance and ledger sum; don't report a false mismatch during a concurrent sale.
  const [row] = await db().select({ item, ledgerBalance: sql<number>`(select coalesce(sum(delta), 0)::bigint from stock_movement m where m.workspace_id = "item"."workspace_id" and m.item_id = "item"."id")` }).from(item).where(itemScope(member.workspaceId, itemId));
  if (!row) throw new NotFoundError();
  const movements = await db().select().from(stockMovement).where(and(eq(stockMovement.workspaceId, member.workspaceId), eq(stockMovement.itemId, itemId))).orderBy(desc(stockMovement.id)).limit(200);
  return { ...row.item, ledgerBalance: Number(row.ledgerBalance), ledgerMatches: Number(row.ledgerBalance) === row.item.onHand, movements: movements.map(movementView) };
}

export async function createItem(actor: { id: string }, workspaceId: string, input: unknown) {
  const member = await requireMember(actor, workspaceId, "manager");
  const data = newItemInput.parse(input);
  try {
    return await db().transaction(async tx => {
      await requireMember(actor, member.workspaceId, "manager", tx);
      await consumeRate(tx, actor.id, "api_write", 200, "Too many item changes. Try again later.");
      await advisoryLock(tx, `item-cap:${member.workspaceId}`);
      const [{ n }] = await tx.select({ n: count() }).from(item).where(eq(item.workspaceId, member.workspaceId));
      if (n >= 2000) throw new ConflictError("A workspace can have up to 2,000 items, including archived items.");
      const [row] = await tx.insert(item).values({ ...data, workspaceId: member.workspaceId }).returning();
      return row;
    });
  } catch (err) { inventoryError(err); }
}

export async function editItem(actor: { id: string }, workspaceId: string, itemId: string, input: unknown) {
  const member = await requireMember(actor, workspaceId, "manager");
  const { version, ...data } = editItemInput.parse(input);
  try {
    return await countConflicts(actor.id, "api_write", 200, "Too many item changes. Try again later.", () => db().transaction(async tx => {
      await requireMember(actor, member.workspaceId, "manager", tx);
      await consumeRate(tx, actor.id, "api_write", 200, "Too many item changes. Try again later.");
      const [row] = await tx.update(item).set({ ...data, version: sql`${item.version} + 1`, updatedAt: new Date() })
        .where(and(itemScope(member.workspaceId, itemId), eq(item.version, version), isNull(item.archivedAt))).returning();
      if (!row) return stockConflict(tx, member.workspaceId, itemId, version);
      return row;
    }));
  } catch (err) { inventoryError(err); }
}

export async function archiveItem(actor: { id: string }, workspaceId: string, itemId: string, input: unknown) {
  const member = await requireMember(actor, workspaceId, "manager");
  const { version } = archiveItemInput.parse(input);
  return countConflicts(actor.id, "api_write", 200, "Too many item changes. Try again later.", () => db().transaction(async tx => {
    await requireMember(actor, member.workspaceId, "manager", tx);
    await consumeRate(tx, actor.id, "api_write", 200, "Too many item changes. Try again later.");
    const [row] = await tx.update(item).set({ archivedAt: new Date(), version: sql`${item.version} + 1`, updatedAt: new Date() })
      .where(and(itemScope(member.workspaceId, itemId), eq(item.version, version), isNull(item.archivedAt))).returning();
    if (!row) return stockConflict(tx, member.workspaceId, itemId, version);
    return row;
  }));
}

export async function lookupItem(actor: { id: string }, workspaceId: string, code: unknown) {
  const member = await requireMember(actor, workspaceId);
  // A code may be a SKU (up to 40) or a barcode (up to 64, Code 128 and QR): accept the longer of the two. No GTIN check
  // here: barcodes were validated on create, and a SKU may look like a GTIN without being one.
  const value = lookupCodeInput.parse(code);
  const rows = await db().select().from(item).where(and(eq(item.workspaceId, member.workspaceId), isNull(item.archivedAt), or(eq(item.barcode, value), eq(item.sku, value)))).limit(2);
  if (!rows.length) throw new NotFoundError("Not in this workspace");
  // A SKU may equal another item's barcode. Never silently record stock against the wrong item.
  if (rows.length > 1) throw new ConflictError("This code matches two items. Search by name instead.");
  return rows[0];
}

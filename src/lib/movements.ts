import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ClientOpReusedError, ConflictError, NotFoundError } from "@/lib/errors";
import { countConflicts, itemScope, movementView, stockConflict } from "@/lib/items";
import { requireMember } from "@/lib/tenancy";
import { advisoryLock, consumeRate } from "@/lib/usage";

const common = { itemId: z.string().uuid(), clientOpId: z.string().uuid(), reason: z.string().trim().max(200).default("") };
const qty = z.number().int().min(1).max(2147483647);
export const movementInput = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("receive"), qty }).strict(),
  z.object({ ...common, kind: z.literal("sale"), qty }).strict(),
  z.object({ ...common, kind: z.literal("adjust"), qty: z.number().int().min(-2147483647).max(2147483647).refine(n => n !== 0), reason: z.string().trim().min(1).max(200) }).strict(),
  z.object({ ...common, kind: z.literal("count"), qty: z.number().int().min(0).max(2147483647), expectedVersion: z.number().int().min(1).max(2147483647) }).strict(),
]);

export async function recordMovement(actor: { id: string }, workspaceId: string, input: unknown) {
  const member = await requireMember(actor, workspaceId);
  const data = movementInput.parse(input);
  const { item, stockMovement } = schema;
  return countConflicts(actor.id, "movement", 600, "Too many stock movements. Try again later.", () => db().transaction(async tx => {
    // Key-share lock: a concurrent workspace delete waits for us instead of deadlocking on the item row.
    const locked = await tx.execute(sql`select 1 from workspace where id = ${member.workspaceId} for key share`);
    if (!locked.length) throw new NotFoundError();
    await requireMember(actor, member.workspaceId, "staff", tx);
    // This is only the operation's lock, never a workspace lock. Two different operations still race on the
    // conditional item UPDATE. Lock before the dedupe read so a concurrent retry observes the first commit.
    await advisoryLock(tx, `stock-op:${member.workspaceId}:${data.clientOpId}`);
    const [first] = await tx.select().from(stockMovement).where(and(eq(stockMovement.workspaceId, member.workspaceId), eq(stockMovement.clientOpId, data.clientOpId)));
    if (first) {
      const sameQty = data.kind === "count" ? first.onHandAfter === data.qty : first.delta === (data.kind === "sale" ? -data.qty : data.qty);
      if (first.itemId !== data.itemId || first.kind !== data.kind || !sameQty) throw new ClientOpReusedError();
      return movementView(first);
    }
    const scope = itemScope(member.workspaceId, data.itemId);
    const [before] = await tx.select().from(item).where(scope);
    if (!before) throw new NotFoundError();
    if (before.archivedAt) throw new ConflictError("This item is archived.");
    await consumeRate(tx, actor.id, "movement", 600, "Too many stock movements. Try again later.");
    if (data.kind === "count" && before.version !== data.expectedVersion) return stockConflict(tx, member.workspaceId, data.itemId, data.expectedVersion);
    const delta = data.kind === "count" ? data.qty - before.onHand : data.kind === "sale" ? -data.qty : data.qty;
    const balance = data.kind === "count" ? sql`${data.qty}::bigint` : sql`${item.onHand}::bigint + ${delta}::bigint`;
    const [after] = await tx.update(item).set({ onHand: balance, version: sql`${item.version} + 1`, updatedAt: new Date() }).where(and(scope,
      isNull(item.archivedAt), sql`${balance} between 0 and 2147483647`,
      data.kind === "count" ? eq(item.version, data.expectedVersion) : undefined,
    )).returning();
    if (!after) return stockConflict(tx, member.workspaceId, data.itemId, data.kind === "count" ? data.expectedVersion : before.version, data.kind === "count" ? undefined : delta);
    const [movement] = await tx.insert(stockMovement).values({ workspaceId: member.workspaceId, itemId: data.itemId,
      kind: data.kind, delta, onHandAfter: after.onHand, itemVersion: after.version, reason: data.reason, actorId: actor.id, clientOpId: data.clientOpId,
    }).returning();
    return movementView(movement);
  }));
}

/** Newest stock activity in this workspace, for the dashboard. Members only; outsiders get 404. */
export async function listRecentMovements(actor: { id: string }, workspaceId: string, limit = 20) {
  const member = await requireMember(actor, workspaceId, "staff");
  const cap = Math.min(Math.max(1, limit), 50);
  const { item, stockMovement } = schema;
  const rows = await db()
    .select({
      id: stockMovement.id,
      itemId: stockMovement.itemId,
      itemName: item.name,
      sku: item.sku,
      kind: stockMovement.kind,
      delta: stockMovement.delta,
      onHandAfter: stockMovement.onHandAfter,
      reason: stockMovement.reason,
      createdAt: stockMovement.createdAt,
    })
    .from(stockMovement)
    .innerJoin(item, and(eq(item.id, stockMovement.itemId), eq(item.workspaceId, stockMovement.workspaceId)))
    .where(eq(stockMovement.workspaceId, member.workspaceId))
    .orderBy(desc(stockMovement.id))
    .limit(cap);
  return rows.map((row) => ({ ...row, id: row.id.toString() }));
}

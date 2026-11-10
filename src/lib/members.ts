import "server-only";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { API_WRITES_PER_HOUR } from "@/lib/domain";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { requireMember, withWorkspace } from "@/lib/tenancy";
import { consumeRate } from "@/lib/usage";

/** Ids in paths are untrusted. A malformed one can't match a member, so it's a 404 like any other stranger. */
const userIdSchema = z.string().min(1).max(128);

export const changeRoleInput = z.object({ role: z.enum(schema.MEMBER_ROLES) }).strict();

const LAST_MANAGER = "A workspace needs at least one manager.";

/** Names and emails of teammates: managers only. Staff see their own role through `getWorkspace`. */
export async function listMembers(actor: { id: string }, workspaceId: string) {
  const member = await requireMember(actor, workspaceId, "manager");
  const { membership, user } = schema;
  return db()
    .select({ userId: user.id, name: user.name, email: user.email, role: membership.role, joinedAt: membership.joinedAt })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.workspaceId, member.workspaceId))
    .orderBy(membership.joinedAt, user.id);
}

/** Change a member's role. The target is looked up inside this workspace only; the last manager can't be demoted. */
export async function changeMemberRole(actor: { id: string }, workspaceId: string, targetUserId: string, input: unknown) {
  const data = changeRoleInput.parse(input);
  const target = userIdSchema.safeParse(targetUserId);
  if (!target.success) {
    await requireMember(actor, workspaceId, "manager"); // strangers get 404 whatever the path says
    throw new NotFoundError();
  }
  return withWorkspace(actor, workspaceId, "manager", async (tx, me) => {
    await consumeRate(tx, actor.id, "api_write", API_WRITES_PER_HOUR, "Too many changes. Try again in a little while.");
    const { membership } = schema;
    const where = and(eq(membership.workspaceId, me.workspaceId), eq(membership.userId, target.data));
    const [row] = await tx.select({ role: membership.role }).from(membership).where(where);
    if (!row) throw new NotFoundError();
    if (row.role === data.role) return { userId: target.data, role: row.role };
    if (row.role === "manager" && (await managerCount(tx, me.workspaceId)) <= 1) throw new ConflictError(LAST_MANAGER);
    await tx.update(membership).set({ role: data.role }).where(where);
    return { userId: target.data, role: data.role };
  });
}

/**
 * Remove a member, or leave (target is yourself: any member may). Removing someone else needs manager. The last
 * manager can neither be removed nor leave.
 */
export async function removeMember(actor: { id: string }, workspaceId: string, targetUserId: string) {
  const target = userIdSchema.safeParse(targetUserId);
  const self = target.success && target.data === actor.id;
  if (!target.success) {
    await requireMember(actor, workspaceId, "manager");
    throw new NotFoundError();
  }
  await withWorkspace(actor, workspaceId, self ? "staff" : "manager", async (tx, me) => {
    await consumeRate(tx, actor.id, "api_write", API_WRITES_PER_HOUR, "Too many changes. Try again in a little while.");
    const { membership } = schema;
    const where = and(eq(membership.workspaceId, me.workspaceId), eq(membership.userId, target.data));
    const [row] = await tx.select({ role: membership.role }).from(membership).where(where);
    if (!row) throw new NotFoundError();
    if (row.role === "manager" && (await managerCount(tx, me.workspaceId)) <= 1) throw new ConflictError(LAST_MANAGER);
    await tx.delete(membership).where(where);
  });
}

async function managerCount(tx: Pick<ReturnType<typeof db>, "select">, workspaceId: string): Promise<number> {
  const { membership } = schema;
  const [{ n }] = await tx
    .select({ n: count() })
    .from(membership)
    .where(and(eq(membership.workspaceId, workspaceId), eq(membership.role, "manager")));
  return n;
}

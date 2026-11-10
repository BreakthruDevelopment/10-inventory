import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/rbac";
import { type Db, db, schema } from "@/lib/db";
import type { MemberRole } from "@/lib/db/schema";
import { NotFoundError } from "@/lib/errors";
import type { Tx } from "@/lib/usage";

/**
 * Tenancy, once. Stock belongs to a workspace, and the only way into a workspace is a `membership` row. Every data
 * function that touches workspace data takes the acting user and the workspace id from the URL, and starts with
 * `requireMember(actor, workspaceId, minRole)`:
 *
 * - not a member (or the id isn't even a uuid, or no such workspace): `NotFoundError` (404), the same answer for
 *   all three, so workspace ids can't be probed;
 * - a member without the role: `ForbiddenError` (403);
 * - the global `admin` role gets no special access here: an admin who isn't a member gets 404 like anyone else
 *   (admins see counts only, through `adminStats`).
 *
 * Callers must then put `workspace_id = <the returned workspaceId>` in every query, and take other ids (items,
 * invites, users) from the path or body only as filters ANDed with that workspace id, never as the scope itself.
 * A workspace id in a request body is never trusted: routes pass the id from the path.
 */

export type { MemberRole };

const RANK: Record<MemberRole, number> = { staff: 1, manager: 2 };

export type MemberContext = { workspaceId: string; userId: string; role: MemberRole };

const uuid = z.string().uuid();

/** A plain handle for reads: the pool or a transaction. */
type Reader = Pick<Db, "select">;

export async function requireMember(
  actor: { id: string },
  workspaceId: unknown,
  minRole: MemberRole = "staff",
  executor: Reader = db(),
): Promise<MemberContext> {
  const id = uuid.safeParse(workspaceId);
  if (!id.success) throw new NotFoundError();
  const { membership } = schema;
  const [row] = await executor
    .select({ workspaceId: membership.workspaceId, userId: membership.userId, role: membership.role })
    .from(membership)
    .where(and(eq(membership.workspaceId, id.data), eq(membership.userId, actor.id)))
    .limit(1);
  if (!row) throw new NotFoundError();
  if (RANK[row.role] < RANK[minRole]) throw new ForbiddenError();
  return row;
}

/**
 * Run `fn` in a transaction that holds the workspace row lock, after `requireMember` has passed inside it. Anything
 * that must stay true across concurrent requests (at least one manager, at most 20 members, at most 10 open
 * invites) is checked in `fn` and can't race: every such writer queues on the same lock, and the membership check is
 * made after the lock, so a member removed a moment ago is refused.
 */
export async function withWorkspace<T>(
  actor: { id: string },
  workspaceId: unknown,
  minRole: MemberRole,
  fn: (tx: Tx, member: MemberContext) => Promise<T>,
): Promise<T> {
  const id = uuid.safeParse(workspaceId);
  if (!id.success) throw new NotFoundError();
  // Strangers and under-privileged members are refused before any lock is taken, so probing a workspace id can
  // never make a manager wait. The check is repeated under the lock for the members who passed.
  await requireMember(actor, id.data, minRole);
  return db().transaction(async (tx) => {
    const locked = await tx.select({ id: schema.workspace.id }).from(schema.workspace).where(eq(schema.workspace.id, id.data)).for("update");
    if (locked.length === 0) throw new NotFoundError();
    const member = await requireMember(actor, id.data, minRole, tx);
    return fn(tx, member);
  });
}

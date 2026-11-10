import "server-only";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { API_WRITES_PER_HOUR, MAX_WORKSPACES_PER_USER } from "@/lib/domain";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { requireMember } from "@/lib/tenancy";
import { advisoryLock, consumeRate } from "@/lib/usage";

const timeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

export const newWorkspaceInput = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(80),
    timeZone: timeZone.default("UTC"),
  })
  .strict();

/** A user's own workspaces only: the join on `membership.user_id = actor` is the whole scope. */
export async function listMyWorkspaces(actor: { id: string }) {
  const { workspace, membership } = schema;
  return db()
    .select({ id: workspace.id, name: workspace.name, timeZone: workspace.timeZone, role: membership.role, joinedAt: membership.joinedAt })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .where(eq(membership.userId, actor.id))
    .orderBy(workspace.name, workspace.id);
}

export async function getWorkspace(actor: { id: string }, workspaceId: string) {
  const member = await requireMember(actor, workspaceId, "staff");
  const { workspace } = schema;
  const [row] = await db()
    .select({ id: workspace.id, name: workspace.name, timeZone: workspace.timeZone, createdAt: workspace.createdAt })
    .from(workspace)
    .where(eq(workspace.id, member.workspaceId));
  if (!row) throw new NotFoundError();
  return { ...row, role: member.role };
}

/** Whoever creates a workspace is its first manager. At most 3 created per user, counted under a per-user lock. */
export async function createWorkspace(actor: { id: string }, input: unknown) {
  const data = newWorkspaceInput.parse(input);
  return db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "api_write", API_WRITES_PER_HOUR, "Too many changes. Try again in a little while.");
    await advisoryLock(tx, `workspace-create:${actor.id}`);
    const { workspace, membership } = schema;
    const [{ n }] = await tx.select({ n: count() }).from(workspace).where(eq(workspace.createdBy, actor.id));
    if (n >= MAX_WORKSPACES_PER_USER) {
      throw new ConflictError(`You can create up to ${MAX_WORKSPACES_PER_USER} workspaces.`);
    }
    const [row] = await tx.insert(workspace).values({ name: data.name, timeZone: data.timeZone, createdBy: actor.id }).returning();
    await tx.insert(membership).values({ workspaceId: row.id, userId: actor.id, role: "manager" });
    return { id: row.id, name: row.name, timeZone: row.timeZone, role: "manager" as const, createdAt: row.createdAt };
  });
}


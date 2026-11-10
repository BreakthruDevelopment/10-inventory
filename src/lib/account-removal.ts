import "server-only";
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * Run just before an account is deleted (Better Auth `databaseHooks.user.delete.before`), so that deleting a
 * workspace's last manager never leaves the workspace unmanageable:
 * - a workspace where the user is the only member is deleted (it has nobody left);
 * - a workspace with other members where the user is the last manager promotes its longest-serving remaining member
 *   (earliest `joined_at`, then user id) to manager.
 * One transaction; workspaces are locked in id order so two concurrent removals can't deadlock on each other here.
 * Logs ids only. The trigger from migration 0004 stays as the backstop for any path that doesn't come through here.
 */
export async function prepareUserRemoval(userId: string): Promise<{ deleted: number; promoted: number }> {
  const { membership, workspace } = schema;
  return db().transaction(async (tx) => {
    const mine = await tx
      .select({ workspaceId: membership.workspaceId, role: membership.role })
      .from(membership)
      .where(eq(membership.userId, userId));
    if (mine.length === 0) return { deleted: 0, promoted: 0 };
    const ids = mine.map((m) => m.workspaceId).sort();
    await tx.select({ id: workspace.id }).from(workspace).where(inArray(workspace.id, ids)).orderBy(asc(workspace.id)).for("update");

    let deleted = 0;
    let promoted = 0;
    for (const m of mine) {
      const [{ others }] = await tx
        .select({ others: count() })
        .from(membership)
        .where(and(eq(membership.workspaceId, m.workspaceId), ne(membership.userId, userId)));
      if (others === 0) {
        await tx.delete(workspace).where(eq(workspace.id, m.workspaceId));
        deleted += 1;
        log.info("account_removal.workspace_deleted", { workspaceId: m.workspaceId, userId });
        continue;
      }
      if (m.role !== "manager") continue;
      const [{ otherManagers }] = await tx
        .select({ otherManagers: count() })
        .from(membership)
        .where(and(eq(membership.workspaceId, m.workspaceId), eq(membership.role, "manager"), ne(membership.userId, userId)));
      if (otherManagers > 0) continue;
      const [next] = await tx
        .select({ userId: membership.userId })
        .from(membership)
        .where(and(eq(membership.workspaceId, m.workspaceId), ne(membership.userId, userId)))
        .orderBy(asc(membership.joinedAt), asc(membership.userId))
        .limit(1);
      await tx
        .update(membership)
        .set({ role: "manager" })
        .where(and(eq(membership.workspaceId, m.workspaceId), eq(membership.userId, next.userId)));
      promoted += 1;
      log.info("account_removal.manager_promoted", { workspaceId: m.workspaceId, removedUserId: userId, promotedUserId: next.userId });
    }
    return { deleted, promoted };
  });
}

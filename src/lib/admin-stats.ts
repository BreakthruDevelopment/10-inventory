import "server-only";
import { count, gt, isNull, and, sql } from "drizzle-orm";
import { ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { dailyCount } from "@/lib/usage";

/**
 * Admin sees counts only: how many users, workspaces, members and open invites, and today's AI calls against the
 * app-wide cap. No workspace names, no member names or emails, no item names or stock. Items and movements per day
 * are added with the item tables (issue 10.2).
 */
export async function adminStats(actor: { role: string }) {
  if (actor.role !== "admin") throw new ForbiddenError();
  const d = db();
  const { user, workspace, membership, invite } = schema;
  const [[users], [workspaces], [memberships], [openInvites]] = await Promise.all([
    d.select({ n: count() }).from(user),
    d.select({ n: count() }).from(workspace),
    d.select({ n: count() }).from(membership),
    d
      .select({ n: count() })
      .from(invite)
      .where(and(isNull(invite.usedAt), isNull(invite.revokedAt), gt(invite.expiresAt, sql`now()`))),
  ]);
  return {
    users: users.n,
    workspaces: workspaces.n,
    memberships: memberships.n,
    openInvites: openInvites.n,
    aiCallsToday: await dailyCount("ai"),
    aiDailyCap: env().FORECAST_DAILY_CAP,
  };
}

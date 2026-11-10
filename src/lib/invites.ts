import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import {
  INVITES_PER_WORKSPACE_PER_DAY,
  INVITE_ACCEPTS_PER_HOUR,
  INVITE_TTL_DAYS,
  MAX_MEMBERS,
  MAX_OPEN_INVITES,
} from "@/lib/domain";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { requireMember, withWorkspace } from "@/lib/tenancy";
import { consumeRate } from "@/lib/usage";

/** 32 random bytes as base64url: always 43 characters. Anything else can't be one of our tokens. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const newInviteInput = z.object({ role: z.enum(schema.MEMBER_ROLES).default("staff") }).strict();

/** Only this hash is stored. The token has 256 bits of entropy, so an unsalted SHA-256 can't be reversed. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const INVALID = "This invite link isn't valid.";
const idSchema = z.string().uuid();

const openInvite = (workspaceId: string) => {
  const { invite } = schema;
  return and(eq(invite.workspaceId, workspaceId), isNull(invite.usedAt), isNull(invite.revokedAt), gt(invite.expiresAt, sql`now()`));
};

/**
 * Create an invite link (manager only). The token is returned once, inside the link; only its hash is stored.
 * Caps, counted under the workspace lock: at most 10 open invites, 20 created per workspace per day (revoked ones
 * still count, so revoke-and-recreate can't be used to dodge the cap).
 */
export async function createInvite(actor: { id: string }, workspaceId: string, input: unknown) {
  const data = newInviteInput.parse(input ?? {});
  return withWorkspace(actor, workspaceId, "manager", async (tx, me) => {
    const { invite } = schema;
    const [{ open }] = await tx.select({ open: count() }).from(invite).where(openInvite(me.workspaceId));
    if (open >= MAX_OPEN_INVITES) throw new ConflictError(`A workspace can have ${MAX_OPEN_INVITES} open invites. Revoke one first.`);
    const [{ today }] = await tx
      .select({ today: count() })
      .from(invite)
      .where(and(eq(invite.workspaceId, me.workspaceId), gt(invite.createdAt, sql`now() - interval '1 day'`)));
    if (today >= INVITES_PER_WORKSPACE_PER_DAY) throw new ConflictError("This workspace has created its invites for today. Try again tomorrow.");
    const token = randomBytes(32).toString("base64url");
    const [row] = await tx
      .insert(invite)
      .values({
        workspaceId: me.workspaceId,
        tokenHash: hashToken(token),
        role: data.role,
        expiresAt: sql`now() + make_interval(days => ${INVITE_TTL_DAYS})`,
        createdBy: actor.id,
      })
      .returning({ id: invite.id, role: invite.role, expiresAt: invite.expiresAt, createdAt: invite.createdAt });
    log.info("invite.created", { workspaceId: me.workspaceId, inviteId: row.id, role: row.role });
    return { invite: row, token, url: `${env().APP_URL.replace(/\/$/, "")}/join/${token}` };
  });
}

/** Invites of this workspace, newest first. Never includes the token or its hash (the link can't be recovered). */
export async function listInvites(actor: { id: string }, workspaceId: string) {
  const me = await requireMember(actor, workspaceId, "manager");
  const { invite } = schema;
  const rows = await db()
    .select({
      id: invite.id,
      role: invite.role,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
      createdAt: invite.createdAt,
      open: sql<boolean>`(${invite.usedAt} is null and ${invite.revokedAt} is null and ${invite.expiresAt} > now())`,
    })
    .from(invite)
    .where(eq(invite.workspaceId, me.workspaceId))
    .orderBy(desc(invite.createdAt), desc(invite.id))
    .limit(50);
  return rows;
}

/**
 * Revoke an invite of this workspace. The invite id is only a filter ANDed with the workspace id from the path, so a
 * manager can't touch another workspace's invites (404). Revoking twice is a no-op; a used invite can't be revoked.
 */
export async function revokeInvite(actor: { id: string }, workspaceId: string, inviteId: string) {
  const id = idSchema.safeParse(inviteId);
  if (!id.success) {
    await requireMember(actor, workspaceId, "manager");
    throw new NotFoundError();
  }
  await withWorkspace(actor, workspaceId, "manager", async (tx, me) => {
    const { invite } = schema;
    const where = and(eq(invite.id, id.data), eq(invite.workspaceId, me.workspaceId));
    const [row] = await tx.select({ usedAt: invite.usedAt, revokedAt: invite.revokedAt }).from(invite).where(where);
    if (!row) throw new NotFoundError();
    if (row.usedAt) throw new ConflictError("That invite was already used.");
    if (!row.revokedAt) await tx.update(invite).set({ revokedAt: sql`now()` }).where(where);
  });
}

export type AcceptResult = { workspaceId: string; role: "manager" | "staff"; joined: boolean };

/**
 * Accept an invite link as the signed-in user. Every failure (malformed, unknown, expired, revoked, used by someone
 * else) is the same 404, so a token can't be probed for its state. Rules:
 * - Attempts are counted first, in their own committed transaction (30 per user per hour), valid or not.
 * - Already a member of that workspace: nothing changes (no role change, the invite isn't consumed): `joined: false`.
 *   So accepting twice is a no-op and a staff member can't promote themselves with a manager link.
 * - Otherwise the invite is claimed with one conditional UPDATE (`used_at is null and revoked_at is null and
 *   expires_at > now()`) under the workspace lock, so concurrent accepts of one link admit exactly one person, and
 *   the 20-member cap is checked in the same transaction (a full workspace rolls the claim back).
 */
export async function acceptInvite(actor: { id: string }, token: unknown): Promise<AcceptResult> {
  await db().transaction((tx) =>
    consumeRate(tx, actor.id, "invite", INVITE_ACCEPTS_PER_HOUR, "Too many invite attempts. Try again in a little while."),
  );
  const parsed = z.string().regex(TOKEN).safeParse(token);
  if (!parsed.success) throw new NotFoundError(INVALID);
  const { invite, membership, workspace } = schema;
  const [found] = await db()
    .select({ id: invite.id, workspaceId: invite.workspaceId })
    .from(invite)
    .where(eq(invite.tokenHash, hashToken(parsed.data)));
  if (!found) throw new NotFoundError(INVALID);

  return db().transaction(async (tx) => {
    const locked = await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, found.workspaceId)).for("update");
    if (locked.length === 0) throw new NotFoundError(INVALID);

    const [existing] = await tx
      .select({ role: membership.role })
      .from(membership)
      .where(and(eq(membership.workspaceId, found.workspaceId), eq(membership.userId, actor.id)));
    if (existing) return { workspaceId: found.workspaceId, role: existing.role, joined: false };

    const [claimed] = await tx
      .update(invite)
      .set({ usedBy: actor.id, usedAt: sql`now()` })
      .where(and(eq(invite.id, found.id), isNull(invite.usedAt), isNull(invite.revokedAt), gt(invite.expiresAt, sql`now()`)))
      .returning({ role: invite.role });
    if (!claimed) throw new NotFoundError(INVALID);

    const [{ members }] = await tx.select({ members: count() }).from(membership).where(eq(membership.workspaceId, found.workspaceId));
    if (members >= MAX_MEMBERS) throw new ConflictError(`This workspace is full (${MAX_MEMBERS} members).`);

    await tx.insert(membership).values({ workspaceId: found.workspaceId, userId: actor.id, role: claimed.role });
    log.info("invite.accepted", { workspaceId: found.workspaceId, inviteId: found.id, role: claimed.role });
    return { workspaceId: found.workspaceId, role: claimed.role, joined: true };
  });
}

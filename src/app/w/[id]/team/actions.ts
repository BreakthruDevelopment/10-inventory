"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createInvite, revokeInvite } from "@/lib/invites";
import { changeMemberRole, removeMember } from "@/lib/members";
import { actionError } from "../action-error";
import { textValue } from "../form-values";

export type InviteState = { error?: string; url?: string; expiresAt?: string; role?: string };
export type MemberState = { error?: string };

function refreshTeam(workspaceId: string) {
  revalidatePath(`/w/${workspaceId}`);
  revalidatePath(`/w/${workspaceId}/team`);
}

export async function createInviteAction(workspaceId: string, _prev: InviteState, form: FormData): Promise<InviteState> {
  const role = textValue(form.get("role")) || "staff";
  try {
    const user = await requireUser();
    const created = await createInvite(user, workspaceId, { role });
    refreshTeam(workspaceId);
    const expiresAt = created.invite.expiresAt instanceof Date ? created.invite.expiresAt.toISOString() : new Date(created.invite.expiresAt).toISOString();
    return { url: created.url, expiresAt, role: created.invite.role };
  } catch (err) {
    return { error: actionError(err, "invite.create_failed") };
  }
}

export async function revokeInviteAction(workspaceId: string, inviteId: string, prev: MemberState, form: FormData): Promise<MemberState> {
  void prev;
  void form;
  try {
    const user = await requireUser();
    await revokeInvite(user, workspaceId, inviteId);
  } catch (err) {
    return { error: actionError(err, "invite.revoke_failed") };
  }
  refreshTeam(workspaceId);
  return {};
}

export async function changeRoleAction(
  workspaceId: string,
  userId: string,
  role: "manager" | "staff",
): Promise<MemberState> {
  try {
    const user = await requireUser();
    await changeMemberRole(user, workspaceId, userId, { role });
  } catch (err) {
    return { error: actionError(err, "member.role_failed") };
  }
  refreshTeam(workspaceId);
  return {};
}

export async function removeMemberAction(workspaceId: string, userId: string): Promise<MemberState> {
  try {
    const user = await requireUser();
    await removeMember(user, workspaceId, userId);
  } catch (err) {
    return { error: actionError(err, "member.remove_failed") };
  }
  refreshTeam(workspaceId);
  return {};
}

/** Any member may leave. The last manager is refused by the data function. */
export async function leaveWorkspaceAction(workspaceId: string, prev: MemberState, form: FormData): Promise<MemberState> {
  void prev;
  void form;
  try {
    const user = await requireUser();
    await removeMember(user, workspaceId, user.id);
  } catch (err) {
    return { error: actionError(err, "member.leave_failed") };
  }
  redirect("/workspaces");
}

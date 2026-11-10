"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { acceptInvite } from "@/lib/invites";

export type JoinState = { error?: string };

export async function acceptInviteAction(token: string): Promise<JoinState> {
  let workspaceId: string;
  try {
    workspaceId = (await acceptInvite(await requireUser(), token)).workspaceId;
  } catch (err) {
    if (err instanceof HttpError) return { error: err.message };
    throw err;
  }
  redirect(`/w/${workspaceId}`);
}

"use server";

import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { requireUser } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { createWorkspace } from "@/lib/workspaces";

export type CreateState = { error?: string };

// Server actions are public endpoints: each one re-reads the session itself.
export async function createWorkspaceAction(_prev: CreateState, form: FormData): Promise<CreateState> {
  let id: string;
  try {
    const user = await requireUser();
    id = (await createWorkspace(user, { name: form.get("name") })).id;
  } catch (err) {
    if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Invalid input" };
    if (err instanceof HttpError) return { error: err.message };
    throw err;
  }
  redirect(`/w/${id}`);
}

"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { HttpError } from "@/lib/errors";

export type DemoState = { message?: string; error?: string };

export async function loadDemoAction(): Promise<DemoState> {
  try {
    const actor = await requireRole("admin");
    const r = await loadDemoWorkspace(actor, { mode: "admin" }, { reserve: true });
    revalidatePath("/admin");
    return { message: `Loaded the demo workspace: ${r.members} members.` };
  } catch (err) {
    if (err instanceof HttpError) return { error: err.message };
    throw err;
  }
}

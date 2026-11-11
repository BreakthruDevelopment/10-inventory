import { cache } from "react";
import { notFound } from "next/navigation";
import { requireUserOrRedirect, type CurrentUser } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { getWorkspace } from "@/lib/workspaces";

export type WorkspacePage = {
  user: CurrentUser;
  workspace: Awaited<ReturnType<typeof getWorkspace>>;
};

/** One membership lookup per request, shared by the page and the workspace nav. */
export const loadWorkspacePage = cache(async (id: string): Promise<WorkspacePage | null> => {
  const user = await requireUserOrRedirect();
  try {
    const workspace = await getWorkspace(user, id);
    return { user, workspace };
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
});

export async function requireWorkspacePage(id: string): Promise<WorkspacePage> {
  const loaded = await loadWorkspacePage(id);
  if (!loaded) notFound();
  return loaded;
}

import type { ReactNode } from "react";
import { requireWorkspacePage } from "./load";
import { WorkspaceNav } from "./workspace-nav";

/** Workspace nav above a page. Membership is checked here and in the page; both share one lookup. */
export async function WorkspaceChrome({ id, children }: { id: string; children: ReactNode }) {
  const { workspace } = await requireWorkspacePage(id);
  return (
    <>
      <WorkspaceNav id={workspace.id} manager={workspace.role === "manager"} />
      {children}
    </>
  );
}

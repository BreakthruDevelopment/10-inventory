import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { getWorkspace } from "@/lib/workspaces";

export const metadata: Metadata = { title: "Workspace" };
export const dynamic = "force-dynamic";

/** Placeholder landing page for a workspace. The dashboard, items and team pages arrive with issue 10.4. */
export default async function WorkspacePage({ params }: PageProps<"/w/[id]">) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  const workspace = await getWorkspace(user, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return (
    <>
      <PageIntro section="Workspace" title={workspace.name} description={`You are ${workspace.role === "manager" ? "a manager" : "staff"} here.`} />
      <Panel title="Stock">
        <p className="mb-4 text-muted">The item list and forecast are coming next.</p>
        <Link
          href={`/w/${workspace.id}/scan`}
          className="inline-flex h-14 min-h-14 items-center justify-center rounded-card bg-accent px-6 text-base font-semibold text-accent-foreground"
        >
          Scan
        </Link>
      </Panel>
    </>
  );
}

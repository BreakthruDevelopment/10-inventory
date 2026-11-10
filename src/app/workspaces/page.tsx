import type { Metadata } from "next";
import Link from "next/link";
import { type Column, DataList, PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listMyWorkspaces } from "@/lib/workspaces";
import { CreateWorkspaceForm } from "./create-form";

export const metadata: Metadata = { title: "Workspaces" };
export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof listMyWorkspaces>>[number];

export default async function WorkspacesPage() {
  const user = await requireUserOrRedirect();
  const rows = await listMyWorkspaces(user);
  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Workspace",
      primary: true,
      cell: (w) => (
        <Link href={`/w/${w.id}`} className="font-semibold text-accent break-words underline-offset-2 hover:underline">
          {w.name}
        </Link>
      ),
    },
    { key: "role", header: "Your role", cell: (w) => (w.role === "manager" ? "Manager" : "Staff") },
  ];
  return (
    <>
      <PageIntro
        section="Workspaces"
        title="Your workspaces"
        description="One workspace per shop or team. You only ever see the ones you belong to."
      />
      <Panel title="Your workspaces" count={rows.length}>
        <DataList
          caption="Workspaces"
          rows={rows}
          rowKey={(w) => w.id}
          columns={columns}
          empty="You aren't in a workspace yet. Create one below, or open an invite link from your manager."
        />
      </Panel>
      <Panel title="Create a workspace">
        <CreateWorkspaceForm />
      </Panel>
    </>
  );
}

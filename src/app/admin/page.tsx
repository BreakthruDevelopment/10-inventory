import { desc } from "drizzle-orm";
import type { Metadata } from "next";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { adminStats } from "@/lib/admin-stats";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { DemoButton } from "./demo-button";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const stats = await adminStats(admin);
  const users = await db()
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .orderBy(desc(schema.user.createdAt))
    .limit(100);

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => u.name },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) => (u.role === "admin" ? <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span> : "User"),
    },
    {
      key: "joined",
      header: "Joined",
      className: "whitespace-nowrap",
      cell: (u) => u.createdAt.toISOString().slice(0, 10),
    },
  ];

  return (
    <>
      <PageIntro section="Admin" title="Overview" description="Counts only: admins never see workspace names, items or stock." />
      <StatGrid>
        <StatTile value={stats.workspaces} label="Workspaces" tone="accent" />
        <StatTile value={stats.items} label="Items" />
        <StatTile value={stats.movementsToday} label="Movements today (UTC)" />
        <StatTile value={stats.memberships} label="Memberships" />
        <StatTile value={stats.openInvites} label="Open invites" />
        <StatTile value={`${stats.aiCallsToday} / ${stats.aiDailyCap}`} label="AI calls today" />
      </StatGrid>
      <Panel title="Demo workspace">
        <DemoButton />
      </Panel>
      <Panel title="All users" count={users.length}>
        <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
      </Panel>
    </>
  );
}

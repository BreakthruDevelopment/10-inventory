import type { Metadata } from "next";
import { type Column, DataList, PageIntro, Panel, StatusBadge, type Status } from "@/components/ui";
import { listInvites } from "@/lib/invites";
import { listMembers } from "@/lib/members";
import { formatWhen } from "../format";
import { requireWorkspacePage } from "../load";
import { ManagerOnly } from "../manager-only";
import { WorkspaceChrome } from "../workspace-chrome";
import { InvitePanel } from "./invite-panel";
import { MemberControls } from "./member-controls";
import { RevokeInviteButton } from "./revoke-button";

export const metadata: Metadata = { title: "Team" };
export const dynamic = "force-dynamic";

type Member = Awaited<ReturnType<typeof listMembers>>[number];
type Invite = Awaited<ReturnType<typeof listInvites>>[number];

function inviteChip(invite: Invite): { status: Status; label: string } {
  if (invite.usedAt) return { status: "live", label: "Used" };
  if (invite.revokedAt) return { status: "blocked", label: "Revoked" };
  if (invite.open === true) return { status: "building", label: "Open" };
  return { status: "not-started", label: "Expired" };
}

export default async function TeamPage({ params }: PageProps<"/w/[id]/team">) {
  const { id } = await params;
  const { user, workspace } = await requireWorkspacePage(id);
  if (workspace.role !== "manager") {
    return (
      <WorkspaceChrome id={workspace.id}>
        <PageIntro section="Team" title="Team" description="Members and invite links." />
        <ManagerOnly what="Team" />
      </WorkspaceChrome>
    );
  }
  const [members, invites] = await Promise.all([listMembers(user, workspace.id), listInvites(user, workspace.id)]);
  const managers = members.filter((member) => member.role === "manager").length;

  const memberColumns: Column<Member>[] = [
    { key: "name", header: "Name", primary: true, cell: (member) => member.name },
    { key: "email", header: "Email", className: "break-all", cell: (member) => <span className="break-all">{member.email}</span> },
    { key: "role", header: "Role", cell: (member) => (member.role === "manager" ? "Manager" : "Staff") },
    {
      key: "joined",
      header: "Joined",
      className: "whitespace-nowrap",
      cell: (member) => formatWhen(member.joinedAt, workspace.timeZone),
    },
    {
      key: "actions",
      header: "Actions",
      hideLabel: true,
      srOnlyHeader: true,
      cell: (member) => (
        <MemberControls
          workspaceId={workspace.id}
          member={{ userId: member.userId, name: member.name, role: member.role }}
          self={member.userId === user.id}
          onlyManager={managers === 1 && member.role === "manager"}
        />
      ),
    },
  ];

  const inviteColumns: Column<Invite>[] = [
    {
      key: "role",
      header: "Role",
      primary: true,
      cell: (invite) => (invite.role === "manager" ? "Manager" : "Staff"),
    },
    {
      key: "status",
      header: "Status",
      cell: (invite) => {
        const chip = inviteChip(invite);
        return <StatusBadge status={chip.status} label={chip.label} />;
      },
    },
    {
      key: "expires",
      header: "Expires",
      className: "whitespace-nowrap",
      cell: (invite) => formatWhen(invite.expiresAt, workspace.timeZone),
    },
    {
      key: "revoke",
      header: "Revoke",
      hideLabel: true,
      srOnlyHeader: true,
      cell: (invite) => (invite.open === true ? <RevokeInviteButton workspaceId={workspace.id} inviteId={invite.id} /> : null),
    },
  ];

  return (
    <WorkspaceChrome id={workspace.id}>
      <PageIntro
        section="Team"
        title="Team"
        description="Invite links are single use. Copy one when you create it. The link is not stored."
      />
      <Panel title="Members" count={members.length}>
        <DataList caption="Members" rows={members} rowKey={(member) => member.userId} columns={memberColumns} empty="No members." />
      </Panel>
      <Panel title="Invite link">
        <p className="mb-3 text-muted">The link works for 7 days, once. At most 10 can be open, and 20 can be created a day.</p>
        <InvitePanel workspaceId={workspace.id} timeZone={workspace.timeZone} />
      </Panel>
      <Panel title="Invites" count={invites.length}>
        <DataList caption="Invites" rows={invites} rowKey={(invite) => invite.id} columns={inviteColumns} empty="No invites yet." />
      </Panel>
    </WorkspaceChrome>
  );
}

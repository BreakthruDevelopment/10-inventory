"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonDanger, buttonSecondary } from "@/components/ui/styles";
import { LeaveWorkspace } from "../leave-button";
import { changeRoleAction, removeMemberAction } from "./actions";

export function MemberControls({
  workspaceId,
  member,
  self,
  onlyManager,
}: {
  workspaceId: string;
  member: { userId: string; name: string; role: "manager" | "staff" };
  self: boolean;
  onlyManager: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function changeRole(role: "manager" | "staff") {
    setPending(true);
    setError(null);
    const result = await changeRoleAction(workspaceId, member.userId, role);
    setPending(false);
    if (result.error) setError(result.error);
    else router.refresh();
  }

  async function remove() {
    setPending(true);
    setError(null);
    const result = await removeMemberAction(workspaceId, member.userId);
    setPending(false);
    if (result.error) setError(result.error);
    else router.refresh();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {member.role === "staff" && (
          <button type="button" disabled={pending} className={buttonSecondary} onClick={() => void changeRole("manager")}>
            {pending ? "Saving…" : "Make manager"}
          </button>
        )}
        {member.role === "manager" && !onlyManager && (
          <button type="button" disabled={pending} className={buttonSecondary} onClick={() => void changeRole("staff")}>
            {pending ? "Saving…" : "Make staff"}
          </button>
        )}
        {self && !onlyManager && <LeaveWorkspace workspaceId={workspaceId} />}
        {!self && !onlyManager && !confirmRemove && (
          <button type="button" disabled={pending} className={buttonDanger} onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        )}
        {!self && !onlyManager && confirmRemove && (
          <>
            <button type="button" disabled={pending} className={buttonDanger} onClick={() => void remove()}>
              {pending ? "Removing…" : `Remove ${member.name}`}
            </button>
            <button type="button" disabled={pending} className={buttonSecondary} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
      {onlyManager && <p className="text-sm text-muted">A workspace needs at least one manager.</p>}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

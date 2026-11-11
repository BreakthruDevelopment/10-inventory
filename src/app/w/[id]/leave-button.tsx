"use client";

import { useActionState, useState } from "react";
import { buttonDanger, buttonSecondary } from "@/components/ui/styles";
import { leaveWorkspaceAction, type MemberState } from "./team/actions";

export function LeaveWorkspace({ workspaceId }: { workspaceId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState<MemberState, FormData>(leaveWorkspaceAction.bind(null, workspaceId), {});
  if (!confirming) {
    return (
      <button type="button" className={buttonDanger} onClick={() => setConfirming(true)}>
        Leave workspace
      </button>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm">You will lose access to this workspace&apos;s stock.</p>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={buttonDanger}>
          {pending ? "Leaving…" : "Yes, leave"}
        </button>
        <button type="button" disabled={pending} className={buttonSecondary} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

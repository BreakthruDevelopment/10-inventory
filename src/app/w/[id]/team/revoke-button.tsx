"use client";

import { useActionState } from "react";
import { buttonDanger } from "@/components/ui/styles";
import { type MemberState, revokeInviteAction } from "./actions";

export function RevokeInviteButton({ workspaceId, inviteId }: { workspaceId: string; inviteId: string }) {
  const [state, action, pending] = useActionState<MemberState, FormData>(revokeInviteAction.bind(null, workspaceId, inviteId), {});
  return (
    <form action={action} className="space-y-2">
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonDanger}>
        {pending ? "Revoking…" : "Revoke"}
      </button>
    </form>
  );
}

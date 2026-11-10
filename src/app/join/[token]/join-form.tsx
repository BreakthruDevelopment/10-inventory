"use client";

import { useActionState } from "react";
import { buttonPrimary } from "@/components/ui/styles";
import { type JoinState, acceptInviteAction } from "./actions";

export function JoinForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<JoinState, FormData>(acceptInviteAction.bind(null, token), {});
  return (
    <form action={action} className="space-y-3">
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Joining…" : "Join workspace"}
      </button>
    </form>
  );
}

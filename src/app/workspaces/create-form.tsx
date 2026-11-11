"use client";

import { useActionState } from "react";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { type CreateState, createWorkspaceAction } from "./actions";

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<CreateState, FormData>(createWorkspaceAction, {});
  return (
    <form action={action} className="space-y-3">
      <label className={labelClass}>
        <span>Workspace name</span>
        <input name="name" required maxLength={80} className={inputClass} placeholder="Corner Café" />
      </label>
      <label className={labelClass}>
        <span>Time zone</span>
        <input name="timeZone" maxLength={64} className={inputClass} placeholder="America/Chicago" autoComplete="off" />
      </label>
      <p className="text-sm text-muted">Optional. An IANA name such as America/Chicago. Blank uses UTC, which the forecast dates use.</p>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}

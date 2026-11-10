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

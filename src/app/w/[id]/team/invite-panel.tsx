"use client";

import { useActionState, useRef, useState } from "react";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { formatWhen } from "../format";
import { type InviteState, createInviteAction } from "./actions";

export function InvitePanel({ workspaceId, timeZone }: { workspaceId: string; timeZone: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(createInviteAction.bind(null, workspaceId), {});
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        <label className={labelClass}>
          <span>Role</span>
          <select name="role" defaultValue="staff" className={inputClass}>
            <option value="staff">Staff</option>
            <option value="manager">Manager</option>
          </select>
        </label>
        {state.error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {state.error}
          </p>
        )}
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "Creating…" : "Create invite link"}
        </button>
      </form>
      {state.url && <InviteLink url={state.url} expiresAt={state.expiresAt} timeZone={timeZone} role={state.role} />}
    </div>
  );
}

function InviteLink({ url, expiresAt, timeZone, role }: { url: string; expiresAt?: string; timeZone: string; role?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Copied");
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setMessage("Select the link and copy it.");
    }
  }
  return (
    <div className="space-y-3 rounded-card border border-border bg-background p-3">
      <p className="text-sm">
        This link is shown once. It invites someone as {role === "manager" ? "a manager" : "staff"}
        {expiresAt ? ` until ${formatWhen(expiresAt, timeZone)}` : ""}.
      </p>
      <label className={labelClass}>
        <span>Invite link</span>
        <input ref={inputRef} readOnly value={url} onFocus={(event) => event.currentTarget.select()} className={`${inputClass} font-mono text-sm`} />
      </label>
      <button type="button" className={buttonSecondary} onClick={() => void copy()}>
        Copy link
      </button>
      {message && (
        <p role="status" className="text-sm font-medium">
          {message}
        </p>
      )}
    </div>
  );
}

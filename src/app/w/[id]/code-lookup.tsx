"use client";

import { useActionState } from "react";
import { buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { type LookupState, lookupCodeAction } from "./actions";

export function CodeLookup({ workspaceId }: { workspaceId: string }) {
  const [state, action, pending] = useActionState<LookupState, FormData>(lookupCodeAction.bind(null, workspaceId), {});
  return (
    <form action={action} className="mt-4 space-y-3">
      <label className={labelClass}>
        <span>Barcode or SKU</span>
        <input
          name="code"
          required
          maxLength={64}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={`${inputClass} font-mono`}
          placeholder="4006381333931"
          aria-describedby={state.error ? "code-lookup-error" : undefined}
        />
      </label>
      {state.error && (
        <p id="code-lookup-error" role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonSecondary}>
        {pending ? "Looking up…" : "Find item"}
      </button>
    </form>
  );
}

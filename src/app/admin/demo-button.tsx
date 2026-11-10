"use client";

import { useActionState } from "react";
import { buttonPrimary } from "@/components/ui/styles";
import { type DemoState, loadDemoAction } from "./actions";

export function DemoButton() {
  const [state, action, pending] = useActionState<DemoState, FormData>(loadDemoAction, {});
  return (
    <form action={action} className="space-y-3">
      <p className="text-muted">Replaces the Demo Corner Store workspace (1 manager, 2 staff). One load per minute.</p>
      {state.message && <p role="status" className="text-sm font-medium">{state.message}</p>}
      {state.error && <p role="alert" className="text-sm font-medium text-danger">{state.error}</p>}
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Loading…" : "Load demo workspace"}
      </button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { DemoBadge, Panel } from "@/components/ui";
import { buttonPrimary } from "@/components/ui/styles";
import { formatWhen } from "../format";
import { type ExplainState, type ShownExplanation, explainForecastAction } from "./actions";
import { ForecastStatusChip } from "./status-chip";

export function ExplainPanel({
  workspaceId,
  timeZone,
  initial,
  names,
  needsReorder,
}: {
  workspaceId: string;
  timeZone: string;
  initial: ShownExplanation | null;
  names: Record<string, string>;
  needsReorder: boolean;
}) {
  const [state, action, pending] = useActionState<ExplainState, FormData>(explainForecastAction.bind(null, workspaceId), {
    explanation: initial,
  });
  const explanation = state.explanation;
  return (
    <Panel title="In plain language" action={explanation?.demo ? <DemoBadge label="Demo explanation" /> : undefined}>
      <div aria-busy={pending} className="space-y-3">
        {pending && (
          <p role="status" className="text-sm text-muted">
            Writing the explanation…
          </p>
        )}
        {!explanation && !pending && (
          <p className="text-sm text-muted">
            {needsReorder
              ? "No explanation yet. The table is the forecast. A model is called only when you ask."
              : "Nothing needs reordering from these numbers. You can still ask, and no model is called."}
          </p>
        )}
        {explanation && (
          <>
            <p>{explanation.overview}</p>
            {explanation.items.length > 0 && (
              <ul className="space-y-3">
                {explanation.items.map((item) => (
                  <li key={item.itemId} className="space-y-1">
                    <p className="font-semibold break-words">{names[item.itemId] ?? "Item"}</p>
                    <ForecastStatusChip status={item.status} belowReorderPoint={false} />
                    <p className="text-sm">{item.text}</p>
                  </li>
                ))}
              </ul>
            )}
            {explanation.caveats.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {explanation.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            )}
            <p className="text-sm text-muted">As of {formatWhen(explanation.createdAt, timeZone)}.</p>
          </>
        )}
        {state.error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {state.error}
          </p>
        )}
        <form action={action}>
          <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
            {pending ? "Explaining…" : "Explain in plain language"}
          </button>
        </form>
      </div>
    </Panel>
  );
}

"use client";

import { useEffect, useId, useRef } from "react";
import { buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { KIND_LABEL, signedDelta } from "../format";
import { changesSinceCount, type StockConflictView } from "./conflict-copy";

/** Stale count: recount or keep mine. A sale that would go negative says "Only N left" and does not retry. */
export function ConflictDialog({
  conflict,
  pending,
  onDismiss,
  onKeepMine,
}: {
  conflict: StockConflictView;
  pending: boolean;
  onDismiss: () => void;
  onKeepMine?: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const panel = panelRef.current;
    panel?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const title = conflict.mode === "delta" ? conflict.message : conflict.mode === "count" ? "This count is out of date" : "This item changed";
  const body = conflict.mode === "delta"
    ? "Change the quantity and try again."
    : conflict.offerChoice
      ? changesSinceCount(conflict.changeCount, conflict.truncated)
      : conflict.message;
  const dismissLabel = conflict.mode === "delta" ? "Change quantity" : conflict.offerChoice ? "Recount" : "Close";

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-foreground/40 p-4 sm:items-center"
      onClick={onDismiss}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-card border border-border bg-surface p-4 sm:p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="font-display text-2xl font-semibold">
          {title}
        </h2>
        <p id={bodyId} className="mt-2 text-sm">
          {body}
        </p>
        <p className="mt-2 text-sm text-muted">On hand now: {conflict.current.onHand.toLocaleString("en")}</p>
        {conflict.movements.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {conflict.movements.map((movement, index) => (
              <li key={`${movement.kind}-${movement.onHandAfter}-${index}`}>
                {KIND_LABEL[movement.kind] ?? movement.kind} {signedDelta(movement.delta)} → {movement.onHandAfter.toLocaleString("en")} on hand
              </li>
            ))}
          </ul>
        )}
        <div className={`mt-4 grid gap-2 ${conflict.offerChoice ? "grid-cols-2" : "grid-cols-1"}`}>
          <button type="button" disabled={pending} className={`${buttonSecondary} min-h-14`} onClick={onDismiss}>
            {dismissLabel}
          </button>
          {conflict.offerChoice && onKeepMine && (
            <button type="button" disabled={pending} className={`${buttonPrimary} min-h-14`} onClick={onKeepMine}>
              {pending ? "Saving…" : "Keep mine"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

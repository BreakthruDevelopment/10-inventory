"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { ConflictDialog } from "../conflict-dialog";
import { type StockConflictView } from "../conflict-copy";
import { recordStockAction } from "./actions";

type Kind = "receive" | "sale" | "adjust" | "count";

const ACTIONS: { kind: Kind; label: string; className: string }[] = [
  { kind: "receive", label: "Receive", className: buttonPrimary },
  { kind: "sale", label: "Sell", className: buttonPrimary },
  { kind: "adjust", label: "Adjust", className: buttonSecondary },
  { kind: "count", label: "Count", className: buttonSecondary },
];

export function StockForm({
  workspaceId,
  item,
}: {
  workspaceId: string;
  item: { id: string; unit: string; onHand: number; version: number };
}) {
  const router = useRouter();
  const qtyRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const lastCount = useRef<{ qty: number; reason: string } | null>(null);
  // One id per attempt: a retry after a lost response reuses it so the server de-duplicates. Cleared on ok/conflict.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<StockConflictView | null>(null);
  const [onHand, setOnHand] = useState(item.onHand);
  const [version, setVersion] = useState(item.version);

  if (!pending && !conflict && item.version > version) {
    setVersion(item.version);
    setOnHand(item.onHand);
  }

  async function send(input: { kind: Kind; qty: number; reason: string; expectedVersion?: number }) {
    setPending(true);
    setError(null);
    const key = JSON.stringify([input.kind, input.qty, input.reason, input.expectedVersion ?? null]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    const clientOpId = attempt.current.id;
    let result: Awaited<ReturnType<typeof recordStockAction>>;
    try {
      result = await recordStockAction(workspaceId, {
        itemId: item.id,
        clientOpId,
        kind: input.kind,
        qty: input.qty,
        reason: input.reason,
        ...(input.kind === "count" ? { expectedVersion: input.expectedVersion } : {}),
      });
    } catch {
      setPending(false);
      setError("Something went wrong");
      return;
    }
    setPending(false);
    if (result.status === "ok" || result.status === "conflict") attempt.current = null;
    if (result.status === "ok") {
      setOnHand(result.onHand);
      setVersion(result.version);
      setConflict(null);
      setNotice(`Recorded. On hand is now ${result.onHand.toLocaleString("en")} ${item.unit}.`);
      router.refresh();
      return;
    }
    if (result.status === "conflict") {
      setOnHand(result.conflict.current.onHand);
      setVersion(result.conflict.current.version);
      setNotice(null);
      setConflict(result.conflict);
      router.refresh();
      return;
    }
    setError(result.error);
  }

  function readValues(): { qty: number; reason: string } | null {
    const raw = qtyRef.current?.value.trim() ?? "";
    const reason = reasonRef.current?.value.trim() ?? "";
    if (!/^-?\d+$/.test(raw)) {
      setError("Enter a whole number.");
      qtyRef.current?.focus();
      return null;
    }
    return { qty: Number(raw), reason };
  }

  async function onKind(kind: Kind) {
    if (pending || conflict) return;
    const values = readValues();
    if (!values) return;
    if ((kind === "receive" || kind === "sale") && values.qty < 1) {
      setError("Enter a quantity of at least 1.");
      return;
    }
    if (kind === "adjust" && values.qty === 0) {
      setError("An adjustment can't be zero.");
      return;
    }
    if (kind === "adjust" && values.reason === "") {
      setError("A reason is required for an adjustment.");
      reasonRef.current?.focus();
      return;
    }
    if (kind === "count" && values.qty < 0) {
      setError("A count can't be negative.");
      return;
    }
    if (kind === "count") lastCount.current = values;
    setError(null);
    await send({ kind, qty: values.qty, reason: values.reason, expectedVersion: kind === "count" ? version : undefined });
  }

  return (
    <>
      <form className="space-y-3" onSubmit={(event) => event.preventDefault()}>
        <p className="text-sm text-muted">
          On hand: <span className="font-semibold text-foreground">{onHand.toLocaleString("en")}</span> {item.unit}. A count is the number on the shelf. A sale or receipt is how many moved.
        </p>
        <label className={labelClass}>
          <span>Quantity</span>
          <input
            ref={qtyRef}
            name="qty"
            type="number"
            inputMode="numeric"
            required
            className={inputClass}
            aria-describedby={error ? "stock-error" : undefined}
          />
        </label>
        <label className={labelClass}>
          <span>Reason</span>
          <input ref={reasonRef} name="reason" maxLength={200} className={inputClass} placeholder="Required for an adjustment" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          {ACTIONS.map((action) => (
            <button
              key={action.kind}
              type="button"
              disabled={pending || conflict !== null}
              className={`${action.className} min-h-14`}
              onClick={() => void onKind(action.kind)}
            >
              {pending ? "Saving…" : action.label}
            </button>
          ))}
        </div>
        {error && (
          <p id="stock-error" role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm font-medium">
            {notice}
          </p>
        )}
      </form>
      {conflict && (
        <ConflictDialog
          conflict={conflict}
          pending={pending}
          onDismiss={() => {
            setConflict(null);
            router.refresh();
            qtyRef.current?.focus();
          }}
          onKeepMine={
            conflict.offerChoice
              ? () => {
                  const values = lastCount.current;
                  if (!values) return;
                  void send({ kind: "count", qty: values.qty, reason: values.reason, expectedVersion: conflict.current.version });
                }
              : undefined
          }
        />
      )}
    </>
  );
}

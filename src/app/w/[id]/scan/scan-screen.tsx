"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { BarcodeScanner } from "@/components/scanner";
import { countConflictMessage, notFoundMessage } from "@/components/scanner/conflict-copy";
import { parseWholeQty, qtyError, savedMessage, type StockKind } from "@/components/scanner/qty";
import { scanPrimary, scanSecondary, stepButton } from "@/components/scanner/styles";
import { inputClass, labelClass } from "@/components/ui/styles";
import { barcodeInput } from "@/lib/barcodes";
import { createScannedItem, lookupScanCode, recordScanMovement } from "./actions";
import type { MovementConflict, ScanItem } from "./scan-types";

type Pending = "lookup" | "create" | StockKind | "keep" | null;

type Found = { status: "found"; code: string; item: ScanItem };
type Missing = { status: "missing"; code: string };
type Notice = { status: "idle" } | Found | Missing | { status: "error"; code: string; error: string };

type CountConflict = MovementConflict & { qty: number };

function barcodeOrNull(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = barcodeInput.safeParse(trimmed);
  return parsed.success ? parsed.data : null;
}

export function ScanScreen({ workspaceId, workspaceName, canCreate }: { workspaceId: string; workspaceName: string; canCreate: boolean }) {
  const nameId = useId();
  const skuId = useId();
  const barcodeId = useId();
  const qtyId = useId();
  const reasonId = useId();
  const settled = useRef<string | null>(null);
  const inflight = useRef<string | null>(null);
  const request = useRef(0);
  const [notice, setNotice] = useState<Notice>({ status: "idle" });
  const [pending, setPending] = useState<Pending>(null);
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [conflict, setConflict] = useState<CountConflict | null>(null);

  const item = notice.status === "found" ? notice.item : null;
  const busy = pending !== null;

  function applyItem(code: string, next: ScanItem) {
    settled.current = code;
    setNotice({ status: "found", code, item: next });
    setQty("1");
    setReason("");
    setConflict(null);
    setFormError(null);
    setSuccess(null);
  }

  async function lookup(code: string, source: "camera" | "manual") {
    const value = code.trim();
    if (!value) return;
    if (source === "camera" && (settled.current === value || inflight.current === value)) return;
    if (value.length > 40) {
      settled.current = value;
      setNotice({ status: "error", code: value, error: "Use a code of 1–40 characters." });
      setFormError(null);
      return;
    }
    const id = ++request.current;
    inflight.current = value;
    setPending("lookup");
    setFormError(null);
    setSuccess(null);
    setConflict(null);
    const result = await lookupScanCode(workspaceId, value);
    if (inflight.current === value) inflight.current = null;
    if (id !== request.current) return;
    setPending(null);
    if (result.status === "found") {
      applyItem(value, result.item);
      return;
    }
    settled.current = value;
    if (result.status === "missing") {
      setNotice({ status: "missing", code: value });
      setSku(value.slice(0, 40));
      setBarcode(barcodeOrNull(value) ?? "");
      setName("");
      return;
    }
    setNotice({ status: "error", code: value, error: result.error });
  }

  function scanAnother() {
    request.current += 1;
    settled.current = null;
    inflight.current = null;
    setPending(null);
    setNotice({ status: "idle" });
    setConflict(null);
    setFormError(null);
    setSuccess(null);
    setQty("1");
    setReason("");
  }

  async function createItem() {
    if (notice.status !== "missing") return;
    const nextName = name.trim();
    const nextSku = sku.trim();
    if (!nextName || !nextSku) {
      setFormError("Enter a name and a SKU.");
      return;
    }
    const nextBarcode = barcode.trim();
    if (nextBarcode && !barcodeInput.safeParse(nextBarcode).success) {
      setFormError("A barcode is 4–64 letters, numbers, dots or hyphens, with a valid check digit.");
      return;
    }
    setPending("create");
    setFormError(null);
    const result = await createScannedItem(workspaceId, {
      name: nextName,
      sku: nextSku,
      barcode: nextBarcode || null,
    });
    setPending(null);
    if (result.status === "found") {
      applyItem(notice.code, result.item);
      return;
    }
    if (result.status === "missing") {
      setFormError("Not in this workspace.");
      return;
    }
    setFormError(result.error);
  }

  async function submit(kind: StockKind, countVersion?: number, countQty?: number) {
    if (!item || busy) return;
    const amount = countQty ?? parseWholeQty(qty);
    const problem = qtyError(kind, amount);
    if (problem || amount === null) {
      setFormError(problem ?? "Enter a whole number.");
      return;
    }
    if (kind === "adjust" && reason.trim().length === 0) {
      setFormError("Add a reason for this adjustment.");
      return;
    }
    setPending(kind === "count" && countVersion !== undefined ? "keep" : kind);
    setFormError(null);
    setSuccess(null);
    const result = await recordScanMovement(workspaceId, {
      itemId: item.id,
      kind,
      qty: amount,
      clientOpId: crypto.randomUUID(),
      ...(kind === "adjust" ? { reason: reason.trim() } : {}),
      ...(kind === "count" ? { expectedVersion: countVersion ?? item.version } : {}),
    });
    setPending(null);
    if (result.status === "ok") {
      setNotice({ status: "found", code: notice.status === "found" ? notice.code : "", item: { ...item, onHand: result.onHand, version: result.version } });
      setConflict(null);
      setSuccess(savedMessage(kind, amount, result.onHand));
      return;
    }
    if (result.status === "conflict") {
      setNotice({
        status: "found",
        code: notice.status === "found" ? notice.code : "",
        item: { ...item, onHand: result.current.onHand, version: result.current.version },
      });
      if (result.offerChoice) {
        setConflict({ ...result, message: countConflictMessage(result.movements, result.truncated), qty: amount });
        setFormError(null);
        return;
      }
      setConflict(result.current.archived ? { ...result, qty: amount } : null);
      setFormError(result.message);
      return;
    }
    setFormError(result.error);
  }

  function step(delta: number) {
    setQty((current) => {
      const next = (parseWholeQty(current) ?? 0) + delta;
      if (next > 2147483647 || next < -2147483647) return current;
      return String(next);
    });
  }

  const missing = notice.status === "missing" ? notice : null;
  const archived = conflict?.current.archived === true;

  return (
    <div className="space-y-4">
      <Link href={`/w/${workspaceId}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent">
        Back to {workspaceName}
      </Link>
      <BarcodeScanner onCode={(code, source) => void lookup(code, source)} submitDisabled={busy} />
      <div className="space-y-3">
        {pending === "lookup" && <p role="status">Looking up…</p>}
        {notice.status === "idle" && pending !== "lookup" && <p className="text-muted">Scan a barcode or type a code.</p>}
        {notice.status === "error" && (
          <p role="alert" className="text-sm font-medium text-danger">
            {notice.error}
          </p>
        )}
        {missing && (
          <div className="space-y-3 rounded-card border border-border bg-surface p-4">
            <p role="status" className="font-medium">
              {notFoundMessage(missing.code)}
            </p>
            {canCreate ? (
              <div className="space-y-3">
                <label className={labelClass} htmlFor={nameId}>
                  <span>Name</span>
                  <input id={nameId} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required className={inputClass} />
                </label>
                <label className={labelClass} htmlFor={skuId}>
                  <span>SKU</span>
                  <input id={skuId} value={sku} onChange={(event) => setSku(event.target.value)} maxLength={40} required className={`${inputClass} font-mono`} />
                </label>
                <label className={labelClass} htmlFor={barcodeId}>
                  <span>Barcode</span>
                  <input
                    id={barcodeId}
                    value={barcode}
                    onChange={(event) => setBarcode(event.target.value)}
                    maxLength={64}
                    className={`${inputClass} font-mono`}
                    aria-describedby={`${barcodeId}-hint`}
                  />
                </label>
                <p id={`${barcodeId}-hint`} className="text-sm text-muted">
                  Leave the barcode blank when this is only a SKU.
                </p>
                {formError && (
                  <p role="alert" className="text-sm font-medium text-danger">
                    {formError}
                  </p>
                )}
                <button type="button" onClick={() => void createItem()} disabled={busy} className={scanPrimary}>
                  {pending === "create" ? "Creating…" : "Create item"}
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted">Ask a manager to add it.</p>
            )}
          </div>
        )}
        {item && (
          <section aria-labelledby="scanned-item" className="space-y-4 rounded-card border border-border bg-surface p-4">
            <div>
              <h2 id="scanned-item" className="font-display text-3xl font-semibold leading-tight">
                {item.name}
              </h2>
              <p className="mt-1 font-mono text-sm text-muted">
                {item.sku}
                {item.barcode ? ` · ${item.barcode}` : ""}
              </p>
              <p className="mt-3 text-4xl font-semibold tabular-nums">
                {item.onHand} <span className="text-lg font-medium text-muted">{item.unit}</span>
              </p>
            </div>
            {success && <p role="status">{success}</p>}
            {formError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {formError}
              </p>
            )}
            {conflict?.offerChoice && (
              <div role="alert" className="space-y-3 rounded-card border border-border bg-building-soft p-3">
                <p>{conflict.message}</p>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setConflict(null)} disabled={busy} className={scanSecondary}>
                    Recount
                  </button>
                  <button type="button" onClick={() => void submit("count", conflict.current.version, conflict.qty)} disabled={busy} className={scanPrimary}>
                    {pending === "keep" ? "Saving…" : "Keep mine"}
                  </button>
                </div>
              </div>
            )}
            <div className="sticky bottom-0 z-10 space-y-3 border-t border-border bg-surface py-3">
              <div className="flex items-center gap-2">
                <button type="button" className={stepButton} aria-label="Decrease quantity" onClick={() => step(-1)} disabled={busy || archived}>
                  −
                </button>
                <label className="min-w-0 flex-1" htmlFor={qtyId}>
                  <span className="sr-only">Quantity</span>
                  <input
                    id={qtyId}
                    value={qty}
                    onChange={(event) => setQty(event.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                    className="h-14 w-full rounded-card border border-border-strong bg-surface text-center text-2xl font-semibold text-foreground tabular-nums"
                    aria-describedby={`${qtyId}-hint`}
                  />
                </label>
                <button type="button" className={stepButton} aria-label="Increase quantity" onClick={() => step(1)} disabled={busy || archived}>
                  +
                </button>
              </div>
              <p id={`${qtyId}-hint`} className="text-sm text-muted">
                Receive and sell use this many. Adjust adds or subtracts it. A count sets on hand to it.
              </p>
              <label className={labelClass} htmlFor={reasonId}>
                <span>Adjustment reason</span>
                <input
                  id={reasonId}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={200}
                  className={inputClass}
                  placeholder="Damaged, found, or a correction"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className={scanPrimary} disabled={busy || archived} onClick={() => void submit("receive")}>
                  {pending === "receive" ? "Saving…" : "Receive"}
                </button>
                <button type="button" className={scanPrimary} disabled={busy || archived} onClick={() => void submit("sale")}>
                  {pending === "sale" ? "Saving…" : "Sell"}
                </button>
                <button type="button" className={scanSecondary} disabled={busy || archived} onClick={() => void submit("adjust")}>
                  {pending === "adjust" ? "Saving…" : "Adjust"}
                </button>
                <button type="button" className={scanSecondary} disabled={busy || archived} onClick={() => void submit("count")}>
                  {pending === "count" ? "Saving…" : "Count"}
                </button>
              </div>
              <button type="button" className={scanSecondary} onClick={scanAnother} disabled={busy}>
                Scan another
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

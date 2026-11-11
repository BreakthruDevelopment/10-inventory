"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { buttonDanger, buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { UNIT_LABEL } from "../../format";
import { ConflictDialog } from "../conflict-dialog";
import { type EditState, archiveItemAction, editItemAction } from "./actions";

const UNITS = ["each", "case", "kg", "l"] as const;

type ItemFields = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit: string;
  reorderPoint: number;
  leadTimeDays: number;
  packSize: number;
  supplierName: string;
  unitCostCents: number;
  version: number;
};

export function EditItemForm({ workspaceId, item }: { workspaceId: string; item: ItemFields }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const versionRef = useRef<HTMLInputElement>(null);
  const [state, action, pending] = useActionState<EditState, FormData>(editItemAction.bind(null, workspaceId, item.id), {});
  useEffect(() => {
    if (state.saved) router.refresh();
  }, [state.saved, router]);
  return (
    <>
      <form ref={formRef} action={action} className="grid gap-3 sm:grid-cols-2">
        <input ref={versionRef} type="hidden" name="version" defaultValue={item.version} />
        <label className={labelClass}>
          <span>SKU</span>
          <input name="sku" required maxLength={40} defaultValue={item.sku} autoComplete="off" className={`${inputClass} font-mono`} />
        </label>
        <label className={labelClass}>
          <span>Name</span>
          <input name="name" required maxLength={120} defaultValue={item.name} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Barcode</span>
          <input name="barcode" maxLength={64} defaultValue={item.barcode ?? ""} autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`} />
        </label>
        <label className={labelClass}>
          <span>Unit</span>
          <select name="unit" defaultValue={item.unit} className={inputClass}>
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {UNIT_LABEL[unit] ?? unit}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          <span>Reorder point</span>
          <input name="reorderPoint" type="number" inputMode="numeric" required min={0} max={100000} defaultValue={item.reorderPoint} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Lead time (days)</span>
          <input name="leadTimeDays" type="number" inputMode="numeric" required min={0} max={90} defaultValue={item.leadTimeDays} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Pack size</span>
          <input name="packSize" type="number" inputMode="numeric" required min={1} max={10000} defaultValue={item.packSize} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Unit cost (cents)</span>
          <input name="unitCostCents" type="number" inputMode="numeric" required min={0} defaultValue={item.unitCostCents} className={inputClass} />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>
          <span>Supplier</span>
          <input name="supplierName" maxLength={120} defaultValue={item.supplierName} className={inputClass} />
        </label>
        {state.error && !state.conflict && (
          <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">
            {state.error}
          </p>
        )}
        {state.saved && (
          <p role="status" className="text-sm font-medium sm:col-span-2">
            Saved.
          </p>
        )}
        <div className="sm:col-span-2">
          <button type="submit" disabled={pending} className={buttonPrimary}>
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
      {state.conflict && (
        <ConflictDialog
          conflict={state.conflict}
          pending={pending}
          onDismiss={() => router.refresh()}
          onKeepMine={
            state.conflict.offerChoice
              ? () => {
                  if (versionRef.current) versionRef.current.value = String(state.conflict?.current.version ?? item.version);
                  formRef.current?.requestSubmit();
                }
              : undefined
          }
        />
      )}
    </>
  );
}

export function ArchiveItemForm({ workspaceId, itemId, version }: { workspaceId: string; itemId: string; version: number }) {
  const [state, action, pending] = useActionState<EditState, FormData>(archiveItemAction.bind(null, workspaceId, itemId), {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="version" value={state.conflict?.current.version ?? version} />
      <p className="text-sm text-muted">Archiving hides the item from stock and the forecast. Its history stays.</p>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonDanger}>
        {pending ? "Archiving…" : "Archive item"}
      </button>
    </form>
  );
}

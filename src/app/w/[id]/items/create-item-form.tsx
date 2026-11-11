"use client";

import { useActionState } from "react";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { UNIT_LABEL } from "../format";
import { type CreateItemState, createItemAction } from "./actions";

const UNITS = ["each", "case", "kg", "l"] as const;

export function CreateItemForm({ workspaceId }: { workspaceId: string }) {
  const [state, action, pending] = useActionState<CreateItemState, FormData>(createItemAction.bind(null, workspaceId), {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className={labelClass}>
        <span>SKU</span>
        <input name="sku" required maxLength={40} autoComplete="off" className={`${inputClass} font-mono`} />
      </label>
      <label className={labelClass}>
        <span>Name</span>
        <input name="name" required maxLength={120} className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Barcode</span>
        <input name="barcode" maxLength={64} autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`} placeholder="Optional" />
      </label>
      <label className={labelClass}>
        <span>Unit</span>
        <select name="unit" defaultValue="each" className={inputClass}>
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {UNIT_LABEL[unit] ?? unit}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        <span>Reorder point</span>
        <input name="reorderPoint" type="number" inputMode="numeric" min={0} max={100000} defaultValue={0} className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Lead time (days)</span>
        <input name="leadTimeDays" type="number" inputMode="numeric" min={0} max={90} defaultValue={0} className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Pack size</span>
        <input name="packSize" type="number" inputMode="numeric" min={1} max={10000} defaultValue={1} className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Unit cost (cents)</span>
        <input name="unitCostCents" type="number" inputMode="numeric" min={0} defaultValue={0} className={inputClass} />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>
        <span>Supplier</span>
        <input name="supplierName" maxLength={120} className={inputClass} placeholder="Optional" />
      </label>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">
          {state.error}
        </p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "Creating…" : "Create item"}
        </button>
      </div>
    </form>
  );
}

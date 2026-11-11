"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { ITEM_UNITS } from "@/lib/db/schema";
import { StockConflictError } from "@/lib/errors";
import { archiveItem, editItem } from "@/lib/items";
import { movementInput, recordMovement } from "@/lib/movements";
import { actionError } from "../../action-error";
import { textValue, wholeNumber } from "../../form-values";
import { conflictMode, type StockConflictView } from "../conflict-copy";

export type StockResult = { status: "ok"; onHand: number; version: number } | { status: "conflict"; conflict: StockConflictView } | { status: "error"; error: string };

export type EditState = { error?: string; saved?: boolean; conflict?: StockConflictView };

const UNITS = new Set<string>(ITEM_UNITS);

function refreshItem(workspaceId: string, itemId: string) {
  revalidatePath(`/w/${workspaceId}`);
  revalidatePath(`/w/${workspaceId}/items`);
  revalidatePath(`/w/${workspaceId}/items/${itemId}`);
  revalidatePath(`/w/${workspaceId}/forecast`);
}

function toConflict(err: StockConflictError, kind: "receive" | "sale" | "adjust" | "count" | null, intent: "stock" | "edit"): StockConflictView {
  const archived = err.current.archivedAt != null;
  const mode = intent === "edit" ? "other" : conflictMode(kind, archived, err.message);
  return {
    mode,
    message: err.message,
    offerChoice: mode === "count" || (intent === "edit" && !archived),
    current: { onHand: err.current.onHand, version: err.current.version, archived },
    changeCount: err.movements.length,
    truncated: err.truncated,
    movements: err.movements.slice(-8).map((movement) => ({
      kind: movement.kind,
      delta: movement.delta,
      onHandAfter: movement.onHandAfter,
    })),
  };
}

export async function recordStockAction(workspaceId: string, input: unknown): Promise<StockResult> {
  try {
    const user = await requireUser();
    const movement = await recordMovement(user, workspaceId, input);
    refreshItem(workspaceId, movement.itemId);
    return { status: "ok", onHand: movement.onHandAfter, version: movement.itemVersion };
  } catch (err) {
    if (err instanceof StockConflictError) {
      const parsed = movementInput.safeParse(input);
      return { status: "conflict", conflict: toConflict(err, parsed.success ? parsed.data.kind : null, "stock") };
    }
    return { status: "error", error: actionError(err, "stock.record_failed") };
  }
}

function itemFields(form: FormData): { error: string } | { data: Record<string, unknown> } {
  const version = wholeNumber(form.get("version"));
  const reorderPoint = wholeNumber(form.get("reorderPoint"));
  const leadTimeDays = wholeNumber(form.get("leadTimeDays"));
  const packSize = wholeNumber(form.get("packSize"));
  const unitCostCents = wholeNumber(form.get("unitCostCents"));
  if (version === undefined || Number.isNaN(version)) return { error: "This item is missing its version. Reload the page." };
  if ([reorderPoint, leadTimeDays, packSize, unitCostCents].some((n) => n === undefined || Number.isNaN(n))) {
    return { error: "Enter whole numbers for reorder point, lead time, pack size and cost." };
  }
  const unit = textValue(form.get("unit")) || "each";
  if (!UNITS.has(unit)) return { error: "Choose a unit." };
  return {
    data: {
      version,
      sku: textValue(form.get("sku")),
      name: textValue(form.get("name")),
      barcode: textValue(form.get("barcode")) || null,
      unit,
      reorderPoint,
      leadTimeDays,
      packSize,
      supplierName: textValue(form.get("supplierName")),
      unitCostCents,
    },
  };
}

export async function editItemAction(workspaceId: string, itemId: string, _prev: EditState, form: FormData): Promise<EditState> {
  const fields = itemFields(form);
  if ("error" in fields) return { error: fields.error };
  try {
    const user = await requireUser();
    await editItem(user, workspaceId, itemId, fields.data);
  } catch (err) {
    if (err instanceof StockConflictError) return { error: err.message, conflict: toConflict(err, null, "edit") };
    return { error: actionError(err, "item.edit_failed") };
  }
  refreshItem(workspaceId, itemId);
  return { saved: true };
}

export async function archiveItemAction(workspaceId: string, itemId: string, _prev: EditState, form: FormData): Promise<EditState> {
  const version = wholeNumber(form.get("version"));
  if (version === undefined || Number.isNaN(version)) return { error: "This item is missing its version. Reload the page." };
  try {
    const user = await requireUser();
    await archiveItem(user, workspaceId, itemId, { version });
  } catch (err) {
    if (err instanceof StockConflictError) {
      return { error: "This item changed. Archive again to use the current version.", conflict: toConflict(err, null, "stock") };
    }
    return { error: actionError(err, "item.archive_failed") };
  }
  revalidatePath(`/w/${workspaceId}/items`);
  redirect(`/w/${workspaceId}/items`);
}

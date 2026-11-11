"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { ITEM_UNITS } from "@/lib/db/schema";
import { createItem } from "@/lib/items";
import { actionError } from "../action-error";
import { textValue, wholeNumber } from "../form-values";

export type CreateItemState = { error?: string };

const UNITS = new Set<string>(ITEM_UNITS);

export async function createItemAction(workspaceId: string, _prev: CreateItemState, form: FormData): Promise<CreateItemState> {
  const reorderPoint = wholeNumber(form.get("reorderPoint"));
  const leadTimeDays = wholeNumber(form.get("leadTimeDays"));
  const packSize = wholeNumber(form.get("packSize"));
  const unitCostCents = wholeNumber(form.get("unitCostCents"));
  if ([reorderPoint, leadTimeDays, packSize, unitCostCents].some((n) => Number.isNaN(n))) {
    return { error: "Enter whole numbers for reorder point, lead time, pack size and cost." };
  }
  const unit = textValue(form.get("unit")) || "each";
  if (!UNITS.has(unit)) return { error: "Choose a unit." };
  let itemId: string;
  try {
    const user = await requireUser();
    const row = await createItem(user, workspaceId, {
      sku: textValue(form.get("sku")),
      name: textValue(form.get("name")),
      barcode: textValue(form.get("barcode")) || null,
      unit,
      ...(reorderPoint !== undefined ? { reorderPoint } : {}),
      ...(leadTimeDays !== undefined ? { leadTimeDays } : {}),
      ...(packSize !== undefined ? { packSize } : {}),
      supplierName: textValue(form.get("supplierName")),
      ...(unitCostCents !== undefined ? { unitCostCents } : {}),
    });
    itemId = row.id;
  } catch (err) {
    return { error: actionError(err, "item.create_failed") };
  }
  revalidatePath(`/w/${workspaceId}`);
  revalidatePath(`/w/${workspaceId}/items`);
  redirect(`/w/${workspaceId}/items/${itemId}`);
}

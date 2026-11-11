"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { lookupItem } from "@/lib/items";
import { actionError } from "./action-error";
import { textValue } from "./form-values";

export type LookupState = { error?: string };

/** Manual barcode or SKU entry. The camera screen is the scan page; this is the same lookup. */
export async function lookupCodeAction(workspaceId: string, _prev: LookupState, form: FormData): Promise<LookupState> {
  const code = textValue(form.get("code"));
  if (!code) return { error: "Enter a barcode or SKU." };
  let itemId: string;
  try {
    const user = await requireUser();
    itemId = (await lookupItem(user, workspaceId, code)).id;
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { error: err.message === "Not in this workspace" ? "Not in this workspace." : "That workspace is not available." };
    }
    if (err instanceof ConflictError) return { error: err.message };
    return { error: actionError(err, "lookup.failed") };
  }
  redirect(`/w/${workspaceId}/items/${itemId}`);
}

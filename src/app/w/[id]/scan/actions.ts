"use server";

import { ZodError } from "zod";
import { requireUser } from "@/lib/auth/session";
import { ConflictError, HttpError, NotFoundError, StockConflictError } from "@/lib/errors";
import { createItem, lookupItem } from "@/lib/items";
import { log } from "@/lib/log";
import { movementInput, recordMovement } from "@/lib/movements";
import { safeErrorFields } from "@/lib/safe-error";
import type { LookupResult, MovementResult, ScanItem } from "./scan-types";

function toScanItem(row: {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit: string;
  onHand: number;
  version: number;
}): ScanItem {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    barcode: row.barcode,
    unit: row.unit,
    onHand: row.onHand,
    version: row.version,
  };
}

function failure(err: unknown): { status: "error"; error: string } {
  if (err instanceof ZodError) return { status: "error", error: err.issues[0]?.message ?? "Invalid input" };
  if (err instanceof HttpError) return { status: "error", error: err.message };
  log.error("scan.failed", safeErrorFields(err));
  return { status: "error", error: "Something went wrong" };
}

export async function lookupScanCode(workspaceId: string, code: string): Promise<LookupResult> {
  try {
    const user = await requireUser();
    return { status: "found", item: toScanItem(await lookupItem(user, workspaceId, code)) };
  } catch (err) {
    if (err instanceof NotFoundError) {
      return err.message === "Not in this workspace" ? { status: "missing" } : { status: "error", error: "That workspace is not available." };
    }
    if (err instanceof ConflictError) return { status: "ambiguous", error: err.message };
    return failure(err);
  }
}

export async function createScannedItem(workspaceId: string, input: unknown): Promise<LookupResult> {
  try {
    const user = await requireUser();
    return { status: "found", item: toScanItem(await createItem(user, workspaceId, input)) };
  } catch (err) {
    if (err instanceof NotFoundError) return { status: "error", error: "That workspace is not available." };
    return failure(err);
  }
}

export async function recordScanMovement(workspaceId: string, input: unknown): Promise<MovementResult> {
  try {
    const user = await requireUser();
    const movement = await recordMovement(user, workspaceId, input);
    return { status: "ok", onHand: movement.onHandAfter, version: movement.itemVersion };
  } catch (err) {
    if (err instanceof StockConflictError) {
      const parsed = movementInput.safeParse(input);
      const archived = err.current.archivedAt != null;
      return {
        status: "conflict",
        message: err.message,
        offerChoice: parsed.success && parsed.data.kind === "count" && !archived,
        current: { onHand: err.current.onHand, version: err.current.version, archived },
        movements: err.movements.map((movement) => ({ kind: movement.kind })),
        truncated: err.truncated,
      };
    }
    return failure(err);
  }
}

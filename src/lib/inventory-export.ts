import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { loadForecastRows } from "@/lib/forecast-service";
import { requireMember } from "@/lib/tenancy";
import { consumeRate } from "@/lib/usage";

/** Quote every cell, escape quotes, and neutralize spreadsheet formulas even after leading whitespace. */
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/**
 * The reorder CSV lists items at or below their reorder point plus everything the forecast says needs a reorder
 * (`reorder_now` or `reorder_soon`), with the computed numbers beside each. It is a list for a person to act on; the app
 * never places an order.
 */
export async function exportItems(actor: { id: string }, workspaceId: string, reorder = false) {
  const member = await requireMember(actor, workspaceId, "manager");
  const { item } = schema;
  return db().transaction(async tx => {
    await requireMember(actor, member.workspaceId, "manager", tx);
    await consumeRate(tx, actor.id, "export", 20, "Too many exports. Try again later.");
    if (reorder) {
      const { rows } = await loadForecastRows(tx, member.workspaceId);
      const wanted = rows.filter(r => r.status === "reorder_now" || r.status === "reorder_soon" || r.onHand <= r.reorderPoint);
      const fields = ["sku", "name", "unit", "onHand", "reorderPoint", "leadTimeDays", "packSize", "status", "avgDaily", "trend", "daysOfCover", "stockoutDate", "reorderBy", "safetyStock", "suggestedQty"] as const;
      return [fields.map(csvCell).join(","), ...wanted.map(row => fields.map(key => csvCell(row[key])).join(","))].join("\r\n") + "\r\n";
    }
    const rows = await tx.select().from(item).where(and(eq(item.workspaceId, member.workspaceId), isNull(item.archivedAt))).orderBy(asc(item.sku), asc(item.id)).limit(2000);
    const columns = ["sku", "name", "barcode", "unit", "onHand", "reorderPoint", "leadTimeDays", "packSize", "supplierName", "unitCostCents", "version"] as const;
    return [columns.map(csvCell).join(","), ...rows.map(row => columns.map(key => csvCell(row[key])).join(","))].join("\r\n") + "\r\n";
  });
}

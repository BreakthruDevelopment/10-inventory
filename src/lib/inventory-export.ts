import "server-only";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireMember } from "@/lib/tenancy";
import { consumeRate } from "@/lib/usage";

/** Quote every cell, escape quotes, and neutralize spreadsheet formulas even after leading whitespace. */
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/** The reorder CSV is the low-stock list; forecast metrics are added by issue 10.3. */
export async function exportItems(actor: { id: string }, workspaceId: string, reorder = false) {
  const member = await requireMember(actor, workspaceId, "manager");
  const { item } = schema;
  return db().transaction(async tx => {
    await requireMember(actor, member.workspaceId, "manager", tx);
    await consumeRate(tx, actor.id, "export", 20, "Too many exports. Try again later.");
    const rows = await tx.select().from(item).where(and(eq(item.workspaceId, member.workspaceId), isNull(item.archivedAt), reorder ? lte(item.onHand, item.reorderPoint) : undefined)).orderBy(asc(item.sku), asc(item.id)).limit(2000);
    const columns = ["sku", "name", "barcode", "unit", "onHand", "reorderPoint", "leadTimeDays", "packSize", "supplierName", "unitCostCents", "version"] as const;
    return [columns.map(csvCell).join(","), ...rows.map(row => columns.map(key => csvCell(row[key])).join(","))].join("\r\n") + "\r\n";
  });
}

import { validGtin } from "@/lib/barcodes";

export type ConflictMode = "count" | "delta" | "other";

export type StockConflictView = {
  mode: ConflictMode;
  message: string;
  /** Count conflicts (and a stale item edit) ask the person to recount or explicitly keep theirs. */
  offerChoice: boolean;
  current: { onHand: number; version: number; archived: boolean };
  /** Movements since the version they started from. Capped at 50; `truncated` means there were more. */
  changeCount: number;
  truncated: boolean;
  movements: { kind: string; delta: number; onHandAfter: number }[];
};

/**
 * The line under a stale count. A negative or empty list means the row changed without a movement
 * (an edit). `truncated` is the latest 50 only.
 */
export function changesSinceCount(count: number, truncated: boolean): string {
  if (count <= 0) return "This item changed since you started counting.";
  const noun = count === 1 ? "change" : "changes";
  const line = truncated ? `At least ${count} ${noun} since you started counting.` : `${count} ${noun} since you started counting.`;
  return truncated ? `${line} The list shows the latest 50.` : line;
}

/** Which dialog to open. Delta conflicts use the server's "Only N left" message and do not offer Keep mine. */
export function conflictMode(kind: "receive" | "sale" | "adjust" | "count" | null, archived: boolean, message: string): ConflictMode {
  if (kind === "count" && !archived) return "count";
  if (kind && kind !== "count" && message.startsWith("Only ")) return "delta";
  return "other";
}

const WORD: Record<string, [string, string]> = {
  sale: ["sale", "sales"],
  receive: ["receipt", "receipts"],
  adjust: ["adjustment", "adjustments"],
  count: ["count", "counts"],
};

/** The count-conflict line from the movements that landed after the version the user saw. */
export function countConflictMessage(movements: { kind: string }[], truncated = false): string {
  const parts: string[] = [];
  for (const kind of ["sale", "receive", "adjust", "count"]) {
    const n = movements.filter((movement) => movement.kind === kind).length;
    if (!n) continue;
    const [one, many] = WORD[kind] ?? [kind, `${kind}s`];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  const what = parts.length ? parts.join(" and ") : "a change";
  const extra = truncated ? " More changes happened than are listed here." : "";
  return `Someone recorded ${what} while you were counting: recount or keep yours.${extra}`;
}

/** Unknown-code copy. A bad check digit that is also not a SKU says so. */
export function notFoundMessage(code: string): string {
  const value = code.trim();
  if (/^(?:\d{8}|\d{12}|\d{13})$/.test(value) && !validGtin(value)) {
    return "That code's check digit is wrong, and it isn't in this workspace.";
  }
  return "Not in this workspace.";
}

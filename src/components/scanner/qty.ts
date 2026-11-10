const QTY_LIMIT = 2147483647;

export type StockKind = "receive" | "sale" | "adjust" | "count";

/** A whole quantity the stock actions accept, including a negative adjustment. */
export function parseWholeQty(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < -QTY_LIMIT || n > QTY_LIMIT) return null;
  return n;
}

export function qtyError(kind: StockKind, qty: number | null): string | null {
  if (qty === null) return "Enter a whole number.";
  if ((kind === "receive" || kind === "sale") && qty < 1) return "Enter a quantity of at least 1.";
  if (kind === "adjust" && qty === 0) return "Enter a quantity other than 0.";
  if (kind === "count" && qty < 0) return "Enter the number you counted, 0 or more.";
  return null;
}

export function savedMessage(kind: StockKind, qty: number, onHand: number): string {
  if (kind === "receive") return `Received ${qty}. ${onHand} on hand.`;
  if (kind === "sale") return `Sold ${qty}. ${onHand} on hand.`;
  if (kind === "adjust") return `Adjusted by ${qty}. ${onHand} on hand.`;
  return `Counted ${qty}. ${onHand} on hand.`;
}

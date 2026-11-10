import { validGtin } from "@/lib/barcodes";

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

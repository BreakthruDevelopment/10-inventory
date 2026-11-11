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

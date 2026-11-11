export type ScanItem = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit: string;
  onHand: number;
  version: number;
};

export type LookupResult =
  | { status: "found"; item: ScanItem }
  | { status: "missing" }
  | { status: "ambiguous"; error: string }
  | { status: "error"; error: string };

export type MovementConflict = {
  message: string;
  offerChoice: boolean;
  current: { onHand: number; version: number; archived: boolean };
  movements: { kind: string }[];
  truncated: boolean;
};

export type MovementResult =
  | { status: "ok"; onHand: number; version: number }
  | ({ status: "conflict" } & MovementConflict)
  | { status: "error"; error: string };

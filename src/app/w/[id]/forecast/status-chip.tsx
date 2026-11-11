import { StatusBadge, type Status } from "@/components/ui";
import type { ForecastStatus } from "@/lib/forecast";

const STATUS: Record<ForecastStatus, { status: Status; label: string }> = {
  reorder_now: { status: "blocked", label: "Reorder now" },
  reorder_soon: { status: "building", label: "Reorder soon" },
  ok: { status: "live", label: "OK" },
  no_data: { status: "not-started", label: "No data" },
};

/** Forecast status, plus a flag when an item with no sales history is already at its reorder point. */
export function ForecastStatusChip({ status, belowReorderPoint }: { status: ForecastStatus; belowReorderPoint: boolean }) {
  const chip = STATUS[status];
  return (
    <span className="inline-flex flex-wrap gap-1">
      <StatusBadge status={chip.status} label={chip.label} />
      {status === "no_data" && belowReorderPoint && <StatusBadge status="blocked" label="At reorder point" />}
    </span>
  );
}

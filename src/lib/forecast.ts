/**
 * Deterministic forecast numbers. Pure functions, no database and no model: the same inputs always give the same
 * numbers, and the forecast table shows them with or without the AI explanation.
 *
 * Definitions (spec 10, "AI feature"):
 * - Only `sale` movements are sales. Receipts, adjustments (including negative ones) and counts change `on_hand`
 *   but are never demand, so they never move `avg_daily`.
 * - `avg_daily` = units sold in the last 28 days / days of history (at most 28). A new item that has 10 days of
 *   history is averaged over 10 days, not diluted over 28.
 * - `trend` = (units sold in the last 7 days / 7) / `avg_daily`.
 * - `days_of_cover` = `on_hand` / `avg_daily`; `stockout_date` = today + whole days of cover.
 * - `reorder_by` = the date `on_hand` reaches `reorder_point`, minus `lead_time_days`, never earlier than today.
 * - `safety_stock` = ceil(0.5 x avg_daily x lead_time_days).
 * - `suggested_qty` = max(0, avg_daily x (lead_time_days + 14) + safety_stock - on_hand), rounded up to `pack_size`.
 * - Status and every cover comparison use the cover as displayed (1 decimal), so "cover is shorter than the lead time"
 *   always agrees with the number on the page.
 * - Status: `no_data` (under 7 days of history, or no sales: no forecast is made), else `reorder_now` (on hand at
 *   or below the reorder point, or cover shorter than the lead time), `reorder_soon` (cover shorter than lead time
 *   + 7 days), otherwise `ok`.
 */

export const WINDOW_DAYS = 28;
export const RECENT_DAYS = 7;
export const MIN_HISTORY_DAYS = 7;
export const SAFETY_FACTOR = 0.5;
export const TARGET_COVER_DAYS = 14;
export const SOON_BUFFER_DAYS = 7;
/** Dates further out than this are reported as null ("more than ten years") instead of a meaningless date. */
export const MAX_DATE_HORIZON_DAYS = 3650;
/** Trend above/below which the explanation may mention a change in pace. */
export const TREND_HIGH = 1.3;
export const TREND_LOW = 0.7;
/** Fewest units sold in the last 7 days for "faster" or "slower" to be claimed: a handful of units is noise, not a trend. */
export const MIN_RECENT_UNITS = 3;

export const FORECAST_STATUSES = ["reorder_now", "reorder_soon", "ok", "no_data"] as const;
export type ForecastStatus = (typeof FORECAST_STATUSES)[number];

export type ForecastInput = {
  onHand: number;
  reorderPoint: number;
  leadTimeDays: number;
  packSize: number;
  /** Units sold (positive) in the last 28 days. */
  sold28: number;
  /** Units sold (positive) in the last 7 days; part of `sold28`. */
  sold7: number;
  /** Whole days since the item's first record (creation or first movement, whichever is earlier). */
  historyDays: number;
  /** Today's calendar date in the workspace's time zone, `YYYY-MM-DD`. */
  today: string;
};

export type ForecastMetrics = {
  status: ForecastStatus;
  /** Units per day, 2 decimals. Null when no forecast is made. */
  avgDaily: number | null;
  /** Last 7 days against the 28-day average, 2 decimals. */
  trend: number | null;
  /** Units sold in the last 7 days. Null when no forecast is made. */
  recentUnits: number | null;
  /** 1 decimal. */
  daysOfCover: number | null;
  stockoutDate: string | null;
  reorderBy: string | null;
  safetyStock: number | null;
  suggestedQty: number | null;
};

/** Guards against floating point noise (0.5 x 3 x 4 must be 6, not 6.000000001) before rounding up. */
const EPS = 1e-9;
// `+ 0` turns -0 into 0.
const ceil = (x: number) => Math.ceil(x - EPS) + 0;
const round = (x: number, places: number) => {
  const f = 10 ** places;
  return Math.round((x + Number.EPSILON) * f) / f;
};

export const NO_DATA: ForecastMetrics = {
  status: "no_data",
  avgDaily: null,
  trend: null,
  recentUnits: null,
  daysOfCover: null,
  stockoutDate: null,
  reorderBy: null,
  safetyStock: null,
  suggestedQty: null,
};

/** `YYYY-MM-DD` plus whole days, with calendar arithmetic that ignores DST. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today's date where the workspace is. An unknown zone name falls back to UTC rather than failing the page. */
export function localDate(now: Date, timeZone: string): string {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function computeForecast(input: ForecastInput): ForecastMetrics {
  const { onHand, reorderPoint, leadTimeDays, packSize, today } = input;
  const sold28 = Math.max(0, input.sold28);
  const sold7 = Math.max(0, Math.min(input.sold7, sold28));
  if (input.historyDays < MIN_HISTORY_DAYS || sold28 <= 0) return NO_DATA;

  const windowDays = Math.min(WINDOW_DAYS, input.historyDays);
  const avg = sold28 / windowDays;
  const trend = sold7 / RECENT_DAYS / avg;
  // Rounded once, here: status, drivers and the page all read this value.
  const rawCover = onHand / avg;
  const cover = round(rawCover, 1);

  const dateIn = (days: number) => (days > MAX_DATE_HORIZON_DAYS ? null : addDays(today, Math.max(0, Math.floor(days + EPS))));
  const safetyStock = ceil(SAFETY_FACTOR * avg * leadTimeDays);
  const need = avg * (leadTimeDays + TARGET_COVER_DAYS) + safetyStock - onHand;
  const suggestedQty = need <= EPS ? 0 : ceil(need / packSize) * packSize;

  let status: ForecastStatus = "ok";
  if (onHand <= reorderPoint || cover < leadTimeDays) status = "reorder_now";
  else if (cover < leadTimeDays + SOON_BUFFER_DAYS) status = "reorder_soon";

  return {
    status,
    avgDaily: round(avg, 2),
    trend: round(trend, 2),
    recentUnits: sold7,
    daysOfCover: cover,
    stockoutDate: dateIn(rawCover),
    reorderBy: dateIn((onHand - reorderPoint) / avg - leadTimeDays),
    safetyStock,
    suggestedQty,
  };
}

export type ItemForecast = ForecastMetrics & {
  itemId: string;
  sku: string;
  name: string;
  unit: string;
  onHand: number;
  reorderPoint: number;
  leadTimeDays: number;
  packSize: number;
  historyDays: number;
  /** On hand is at or below the reorder point. Shown even when no forecast is made, so a stocked-out item isn't hidden. */
  belowReorderPoint: boolean;
};

const STATUS_RANK: Record<ForecastStatus, number> = { reorder_now: 0, reorder_soon: 1, ok: 3, no_data: 4 };

/** Sort rank: a no_data item that is at or below its reorder point sits above the ok items, not at the bottom. */
const rank = (r: ItemForecast) => (r.status === "no_data" && r.belowReorderPoint ? 2 : STATUS_RANK[r.status]);

/** Most urgent first: status, then least cover, then SKU so the order is stable. */
export function compareForecast(a: ItemForecast, b: ItemForecast): number {
  return (
    rank(a) - rank(b) ||
    (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) ||
    a.sku.localeCompare(b.sku) ||
    a.itemId.localeCompare(b.itemId)
  );
}

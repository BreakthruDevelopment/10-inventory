import { describe, expect, it } from "vitest";
import { type ForecastInput, addDays, compareForecast, computeForecast, localDate, type ItemForecast } from "./forecast";

const TODAY = "2026-11-10";
const input = (over: Partial<ForecastInput>): ForecastInput => ({
  onHand: 10, reorderPoint: 0, leadTimeDays: 0, packSize: 1, sold28: 0, sold7: 0, historyDays: 60, today: TODAY, ...over,
});

/**
 * Hand-computed table: every expected value below was worked out on paper from the spec's formulas, not by running
 * the code. Today is 2026-11-10. avg = sold28 / min(28, history); trend = sold7 / 7 / avg; cover = on hand / avg;
 * safety = ceil(0.5 x avg x lead); suggested = ceil(max(0, avg x (lead + 14) + safety - on hand) / pack) x pack.
 */
const TABLE: { name: string; in: Partial<ForecastInput>; out: Record<string, unknown> }[] = [
  {
    // avg 3, trend 34/7/3 = 1.619, cover 2 (< lead 4), reorder by clamps to today, safety 6, need 3 x 18 + 6 - 6 = 54
    name: "fast mover running out before a delivery could arrive",
    in: { onHand: 6, reorderPoint: 5, leadTimeDays: 4, packSize: 6, sold28: 84, sold7: 34 },
    out: { status: "reorder_now", avgDaily: 3, trend: 1.62, daysOfCover: 2, stockoutDate: "2026-11-12", reorderBy: TODAY, safetyStock: 6, suggestedQty: 54 },
  },
  {
    // avg 2, trend 1, cover 50, reorder point reached in 45 days, minus lead 5 = 40 days; need 2 x 19 + 5 - 100 < 0
    name: "healthy steady item needs nothing",
    in: { onHand: 100, reorderPoint: 10, leadTimeDays: 5, sold28: 56, sold7: 14, historyDays: 40 },
    out: { status: "ok", avgDaily: 2, trend: 1, daysOfCover: 50, stockoutDate: "2026-12-30", reorderBy: "2026-12-20", safetyStock: 5, suggestedQty: 0 },
  },
  {
    // avg 4, cover 7.5: not under lead 7, under lead + 7 = 14; safety 14; need 4 x 21 + 14 - 30 = 68 -> 7 packs of 10
    name: "reorder soon: cover between lead time and lead time plus a week",
    in: { onHand: 30, reorderPoint: 10, leadTimeDays: 7, packSize: 10, sold28: 112, sold7: 28, historyDays: 28 },
    out: { status: "reorder_soon", avgDaily: 4, trend: 1, daysOfCover: 7.5, stockoutDate: "2026-11-17", reorderBy: TODAY, safetyStock: 14, suggestedQty: 70 },
  },
  {
    // One sale in 28 days: avg 1/28 = 0.0357 (shown 0.04), trend (1/7)/(1/28) = 4, cover 280 days
    name: "a single sale",
    in: { onHand: 10, reorderPoint: 2, leadTimeDays: 3, sold28: 1, sold7: 1, historyDays: 30 },
    out: { status: "ok", avgDaily: 0.04, trend: 4, daysOfCover: 280, stockoutDate: "2027-08-17", reorderBy: "2027-06-19", safetyStock: 1, suggestedQty: 0 },
  },
  {
    name: "no sales in 60 days of history: no forecast",
    in: { onHand: 0, reorderPoint: 5, sold28: 0, sold7: 0 },
    out: { status: "no_data", avgDaily: null, trend: null, daysOfCover: null, stockoutDate: null, reorderBy: null, safetyStock: null, suggestedQty: null },
  },
  {
    name: "new item with 3 days of history: no forecast even though it sells",
    in: { onHand: 2, reorderPoint: 5, sold28: 10, sold7: 10, historyDays: 3 },
    out: { status: "no_data", avgDaily: null, suggestedQty: null },
  },
  {
    // Exactly 7 days of history: averaged over 7 days (not 28), avg 2, cover 5 in [lead 2, lead + 7 = 9)
    name: "seven days of history is enough, and is averaged over seven days",
    in: { onHand: 10, reorderPoint: 0, leadTimeDays: 2, packSize: 4, sold28: 14, sold7: 14, historyDays: 7 },
    out: { status: "reorder_soon", avgDaily: 2, trend: 1, daysOfCover: 5, stockoutDate: "2026-11-15", reorderBy: "2026-11-13", safetyStock: 2, suggestedQty: 24 },
  },
  {
    // On hand equals the reorder point: reorder now regardless of cover. need 1 x 14 + 0 - 12 = 2 -> one pack of 5
    name: "on hand at the reorder point with no lead time",
    in: { onHand: 12, reorderPoint: 12, leadTimeDays: 0, packSize: 5, sold28: 28, sold7: 7, historyDays: 28 },
    out: { status: "reorder_now", avgDaily: 1, trend: 1, daysOfCover: 12, stockoutDate: "2026-11-22", reorderBy: TODAY, safetyStock: 0, suggestedQty: 5 },
  },
];

describe("computeForecast: hand-computed table of 8 items", () => {
  expect(TABLE).toHaveLength(8);
  for (const row of TABLE) {
    it(row.name, () => {
      expect(computeForecast(input(row.in))).toMatchObject(row.out);
    });
  }
});

describe("computeForecast edge cases", () => {
  it("a spike: one very busy week lifts the average and the trend, and stays finite", () => {
    // sold28 300, sold7 290: avg 10.714, trend 290/7/10.714 = 3.867, cover 9.33; safety ceil(21.43) = 22; need 192.86 + 22 - 100 = 114.86
    const m = computeForecast(input({ onHand: 100, reorderPoint: 10, leadTimeDays: 4, sold28: 300, sold7: 290, historyDays: 28 }));
    expect(m).toMatchObject({ status: "reorder_soon", avgDaily: 10.71, trend: 3.87, daysOfCover: 9.3, stockoutDate: "2026-11-19", reorderBy: "2026-11-14", safetyStock: 22, suggestedQty: 115 });
  });

  it("zero on hand with sales: reorder now, out of stock today", () => {
    const m = computeForecast(input({ onHand: 0, reorderPoint: 0, leadTimeDays: 3, sold28: 28, sold7: 7, historyDays: 28 }));
    expect(m).toMatchObject({ status: "reorder_now", daysOfCover: 0, stockoutDate: TODAY, reorderBy: TODAY });
  });

  it("a quiet last week gives a trend under 1 and does not change the average", () => {
    const m = computeForecast(input({ onHand: 100, sold28: 56, sold7: 7, historyDays: 28 }));
    expect(m).toMatchObject({ avgDaily: 2, trend: 0.5 });
  });

  it("sales that were all older than a week give trend 0", () => {
    expect(computeForecast(input({ onHand: 100, sold28: 56, sold7: 0, historyDays: 28 }))).toMatchObject({ trend: 0 });
  });

  it("negative or inconsistent sales inputs never produce negative numbers", () => {
    expect(computeForecast(input({ sold28: -5, sold7: -5 })).status).toBe("no_data");
    const m = computeForecast(input({ onHand: 5, sold28: 28, sold7: 99, historyDays: 28 }));
    expect(m.trend).toBe(4); // sold7 is clamped to sold28: (28 / 7) / avg 1
    expect(m.suggestedQty).toBeGreaterThanOrEqual(0);
  });

  it("negative adjustments, counts and receipts do not enter the inputs: only on-hand moves the cover", () => {
    // The same sales with a lower on-hand (after a negative adjustment or a count) shortens cover but keeps avg and trend.
    const before = computeForecast(input({ onHand: 40, reorderPoint: 5, leadTimeDays: 4, sold28: 56, sold7: 14, historyDays: 28 }));
    const after = computeForecast(input({ onHand: 6, reorderPoint: 5, leadTimeDays: 4, sold28: 56, sold7: 14, historyDays: 28 }));
    expect([after.avgDaily, after.trend]).toEqual([before.avgDaily, before.trend]);
    expect(before.status).toBe("ok");
    expect(after.status).toBe("reorder_now");
  });

  it("floating point noise does not add a pack or a unit of safety stock", () => {
    // 0.5 x 3 x 4 = 6 exactly: safety 6, not 7. need = 3 x 18 + 6 - 60 = 0 -> nothing to order.
    const m = computeForecast(input({ onHand: 60, leadTimeDays: 4, sold28: 84, sold7: 21, historyDays: 28 }));
    expect(m).toMatchObject({ safetyStock: 6, suggestedQty: 0 });
    const exact = computeForecast(input({ onHand: 59, leadTimeDays: 4, packSize: 1, sold28: 84, sold7: 21, historyDays: 28 }));
    expect(exact.suggestedQty).toBe(1);
  });

  it("a tiny average far in the future reports no date instead of a meaningless one", () => {
    const m = computeForecast(input({ onHand: 100000, reorderPoint: 0, sold28: 1, sold7: 0, historyDays: 28 }));
    expect(m.stockoutDate).toBeNull();
    expect(m.reorderBy).toBeNull();
    expect(m.status).toBe("ok");
  });
});

describe("cover rounding", () => {
  it("status and the displayed cover agree: 3.96 days is shown as 4 and is not under a 4-day lead time", () => {
    const m = computeForecast(input({ onHand: 99, leadTimeDays: 4, sold28: 700, sold7: 175, historyDays: 28 }));
    expect(m).toMatchObject({ daysOfCover: 4, status: "reorder_soon" });
    expect(computeForecast(input({ onHand: 98, leadTimeDays: 4, sold28: 700, sold7: 175, historyDays: 28 }))).toMatchObject({ daysOfCover: 3.9, status: "reorder_now" });
    // The stockout date still uses the unrounded cover: 3.96 days of stock is gone on day 3, not day 4.
    expect(computeForecast(input({ onHand: 99, leadTimeDays: 4, sold28: 700, sold7: 175, historyDays: 28 })).stockoutDate).toBe("2026-11-13");
  });
  it("reports the units sold in the last week", () => {
    expect(computeForecast(input({ onHand: 50, sold28: 56, sold7: 14, historyDays: 28 })).recentUnits).toBe(14);
    expect(computeForecast(input({ sold28: 0 })).recentUnits).toBeNull();
  });
});

describe("dates", () => {
  it("adds days across months, years and leap days", () => {
    expect(addDays("2026-11-10", 30)).toBe("2026-12-10");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
  });

  it("uses the workspace's calendar day", () => {
    const now = new Date("2026-11-10T03:00:00Z");
    expect(localDate(now, "UTC")).toBe("2026-11-10");
    expect(localDate(now, "America/Denver")).toBe("2026-11-09");
    expect(localDate(now, "Pacific/Auckland")).toBe("2026-11-10");
    expect(localDate(now, "Not/AZone")).toBe("2026-11-10");
  });
});

describe("compareForecast", () => {
  const row = (over: Partial<ItemForecast>): ItemForecast => ({
    itemId: "i", sku: "S", name: "n", unit: "each", onHand: 1, reorderPoint: 0, leadTimeDays: 0, packSize: 1, historyDays: 30,
    belowReorderPoint: false, recentUnits: 7, status: "ok", avgDaily: 1, trend: 1, daysOfCover: 5, stockoutDate: null, reorderBy: null, safetyStock: 0, suggestedQty: 0, ...over,
  });
  it("puts a no_data item that is at or below its reorder point above the ok items, so a stocked-out item isn't hidden", () => {
    const rows = [row({ sku: "A", itemId: "a", status: "no_data", daysOfCover: null }), row({ sku: "B", itemId: "b", status: "ok" }),
      row({ sku: "C", itemId: "c", status: "no_data", daysOfCover: null, belowReorderPoint: true }), row({ sku: "D", itemId: "d", status: "reorder_soon" })];
    expect(rows.sort(compareForecast).map((r) => r.sku)).toEqual(["D", "C", "B", "A"]);
  });

  it("sorts the most urgent first and no_data last", () => {
    const rows = [row({ itemId: "a", sku: "A", status: "no_data", daysOfCover: null }), row({ itemId: "b", sku: "B", status: "ok" }),
      row({ itemId: "c", sku: "C", status: "reorder_now", daysOfCover: 3 }), row({ itemId: "d", sku: "D", status: "reorder_now", daysOfCover: 1 })];
    expect(rows.sort(compareForecast).map((r) => r.sku)).toEqual(["D", "C", "B", "A"]);
  });
});

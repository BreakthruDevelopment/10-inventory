/** Display helpers shared by workspace pages. No server-only imports, so client forms can use them too. */

export const KIND_LABEL: Record<string, string> = {
  receive: "Receive",
  sale: "Sale",
  adjust: "Adjust",
  count: "Count",
};

export const UNIT_LABEL: Record<string, string> = {
  each: "Each",
  case: "Case",
  kg: "kg",
  l: "L",
};

export function queryValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

export function formatWhen(value: Date | string, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const zone = safeZone(timeZone);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  }).format(date);
}

/** A calendar date (`YYYY-MM-DD`) from the forecast, not a timestamp. */
export function formatDay(day: string | null): string {
  if (!day) return "—";
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, date)),
  );
}

export function formatDecimal(value: number | null, digits: number): string {
  if (value === null) return "—";
  return value.toLocaleString("en", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatCount(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en");
}

/** Unit cost is stored in cents. Blank currency: the schema has no currency code. */
export function formatCost(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

export function signedDelta(delta: number): string {
  if (delta > 0) return `+${delta.toLocaleString("en")}`;
  return delta.toLocaleString("en");
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

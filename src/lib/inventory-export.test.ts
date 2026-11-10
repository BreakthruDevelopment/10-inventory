import { expect, it } from "vitest";
import { csvCell } from "./inventory-export";
it("neutralizes every spreadsheet formula prefix and escaped leading whitespace", () => {
  for (const prefix of ["=", "+", "-", "@", "\t=", "\r+", "  @", "\n-"]) expect(csvCell(prefix + "formula")).toBe('"\'' + prefix + 'formula"');
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  expect(csvCell(null)).toBe('""');
  expect(csvCell(42)).toBe('"42"');
});

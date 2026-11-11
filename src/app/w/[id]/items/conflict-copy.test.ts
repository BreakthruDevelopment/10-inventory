import { describe, expect, it } from "vitest";
import { changesSinceCount, conflictMode } from "./conflict-copy";

describe("stock conflict copy", () => {
  it("says how many changes landed during a count", () => {
    expect(changesSinceCount(1, false)).toBe("1 change since you started counting.");
    expect(changesSinceCount(3, false)).toBe("3 changes since you started counting.");
    expect(changesSinceCount(50, true)).toBe("At least 50 changes since you started counting. The list shows the latest 50.");
    expect(changesSinceCount(0, false)).toBe("This item changed since you started counting.");
  });

  it("offers a choice only for a live count, and uses Only N left for a short sale", () => {
    expect(conflictMode("count", false, "This item changed. Review the current stock and recount or explicitly keep yours.")).toBe("count");
    expect(conflictMode("count", true, "This item is archived.")).toBe("other");
    expect(conflictMode("sale", false, "Only 2 left")).toBe("delta");
    expect(conflictMode("receive", false, "Stock cannot exceed 2,147,483,647.")).toBe("other");
    expect(conflictMode(null, false, "Only 2 left")).toBe("other");
  });
});

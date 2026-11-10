import { describe, expect, it } from "vitest";
import { barcodeInput } from "./barcodes";
describe("decoded barcode validation", () => {
  it.each(["4006381333931", "96385074", "036000291452", "SKU-ABC.123", "CODE128"])("accepts %s", code => expect(barcodeInput.parse(code)).toBe(code));
  it.each(["4006381333932", "96385075", "036000291453", "abc", "a/bc", "<script>", "a".repeat(65)])("rejects %s", code => expect(barcodeInput.safeParse(code).success).toBe(false));
});

import { z } from "zod";

/** GS1 modulo-10 check digit for EAN-8, UPC-A and EAN-13. Other decoded strings are Code 128/QR/SKUs. */
export function validGtin(code: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13})$/.test(code)) return true;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(code[i]) * weight;
  return (10 - sum % 10) % 10 === Number(code.at(-1));
}
/** The longest barcode (Code 128, QR). A lookup code is a SKU (max 40) or a barcode, so it may be this long. */
export const LOOKUP_CODE_MAX = 64;
/** A scanned or typed lookup code. No GTIN check: barcodes were validated on create, and a SKU may look like a GTIN. */
export const lookupCodeInput = z.string().trim().min(1).max(LOOKUP_CODE_MAX);
export const barcodeInput = z.string().regex(/^[0-9A-Za-z.\-]{4,64}$/).refine(validGtin, "Invalid GTIN check digit");

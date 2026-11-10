/** Formats the scan screen decodes. Names match the Barcode Detection API. */
export const SCAN_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"] as const;

export type ScanFormat = (typeof SCAN_FORMATS)[number];

/** `@zxing/library` `BarcodeFormat` members for the same set. */
export const ZXING_FORMAT_KEYS = ["EAN_13", "EAN_8", "UPC_A", "UPC_E", "CODE_128", "QR_CODE"] as const;

export function zxingFormats<T>(formats: Record<(typeof ZXING_FORMAT_KEYS)[number], T>): T[] {
  return ZXING_FORMAT_KEYS.map((key) => formats[key]);
}

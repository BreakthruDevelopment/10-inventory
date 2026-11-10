import { BarcodeFormat } from "@zxing/browser";
import { describe, expect, it } from "vitest";
import { CAMERA_COPY, classifyCameraError, releasePreview, stopMediaStream, torchAvailable } from "./camera";
import { countConflictMessage, notFoundMessage } from "./conflict-copy";
import { SCAN_FORMATS, ZXING_FORMAT_KEYS, zxingFormats } from "./formats";
import { parseWholeQty } from "./qty";

describe("scan formats", () => {
  it("asks the native detector and ZXing for the same six formats", () => {
    expect([...SCAN_FORMATS]).toEqual(["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"]);
    expect(ZXING_FORMAT_KEYS).toEqual(["EAN_13", "EAN_8", "UPC_A", "UPC_E", "CODE_128", "QR_CODE"]);
    const formats = zxingFormats(BarcodeFormat);
    expect(formats).toHaveLength(6);
    expect(new Set(formats).size).toBe(6);
    expect(formats.every((format) => typeof format === "number")).toBe(true);
  });
});

describe("camera lifecycle", () => {
  it("classifies permission loss separately from a missing camera", () => {
    expect(classifyCameraError({ name: "NotAllowedError" })).toBe("denied");
    expect(classifyCameraError({ name: "SecurityError" })).toBe("denied");
    expect(classifyCameraError({ name: "NotFoundError" })).toBe("missing");
    expect(classifyCameraError({ name: "NotReadableError" })).toBe("busy");
    expect(classifyCameraError({ name: "NotSupportedError" })).toBe("unsupported");
    expect(CAMERA_COPY.denied).toMatch(/Type the code/i);
  });

  it("stops every track and clears the preview, and a second release does not throw", () => {
    const stops: string[] = [];
    const stream = {
      getTracks: () => [
        { readyState: "live", stop: () => stops.push("a") },
        { readyState: "ended", stop: () => stops.push("b") },
      ],
    };
    const video = { srcObject: stream as unknown };
    releasePreview(video, stream);
    releasePreview(video, stream);
    expect(stops).toEqual(["a", "a"]);
    expect(video.srcObject).toBeNull();
  });

  it("ignores a stream that is already gone", () => {
    expect(() => stopMediaStream(null)).not.toThrow();
    expect(torchAvailable({})).toBe(false);
    expect(torchAvailable({ getCapabilities: () => ({ torch: true }) })).toBe(true);
    expect(torchAvailable({ getCapabilities: () => ({}) })).toBe(false);
    expect(
      torchAvailable({
        getCapabilities: () => {
          throw new Error("unsupported");
        },
      }),
    ).toBe(false);
  });
});

describe("scan quantities and conflicts", () => {
  it("parses a whole quantity inside the ledger bounds", () => {
    expect(parseWholeQty(" 4 ")).toBe(4);
    expect(parseWholeQty("-2")).toBe(-2);
    expect(parseWholeQty("0")).toBe(0);
    expect(parseWholeQty("1.5")).toBeNull();
    expect(parseWholeQty("2147483648")).toBeNull();
    expect(parseWholeQty("")).toBeNull();
  });

  it("describes a stale count from the movements that raced it", () => {
    expect(countConflictMessage([{ kind: "sale" }, { kind: "sale" }])).toBe(
      "Someone recorded 2 sales while you were counting: recount or keep yours.",
    );
    expect(countConflictMessage([{ kind: "receive" }, { kind: "adjust" }], true)).toBe(
      "Someone recorded 1 receipt and 1 adjustment while you were counting: recount or keep yours. More changes happened than are listed here.",
    );
    expect(countConflictMessage([])).toMatch(/^Someone recorded a change while you were counting/);
  });

  it("keeps a plain not-found line, and mentions a bad check digit", () => {
    expect(notFoundMessage("4006381333931")).toBe("Not in this workspace.");
    expect(notFoundMessage("4006381333932")).toMatch(/check digit/);
    expect(notFoundMessage("OAT MILK")).toBe("Not in this workspace.");
  });
});

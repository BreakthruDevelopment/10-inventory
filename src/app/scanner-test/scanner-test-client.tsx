"use client";

import { useState } from "react";
import { BarcodeScanner } from "@/components/scanner";

export function ScannerTest() {
  const [last, setLast] = useState<{ code: string; source: "camera" | "manual" } | null>(null);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Development only. Codes stay in this browser and nothing is saved.</p>
      <BarcodeScanner manualLabel="Use this code" onCode={(code, source) => setLast({ code, source })} />
      <p aria-live="polite" className="min-h-11 font-mono text-lg break-all">
        {last ? `${last.source === "manual" ? "Typed" : "Scanned"}: ${last.code}` : "No code yet."}
      </p>
    </div>
  );
}

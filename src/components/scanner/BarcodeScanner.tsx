"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { inputClass, labelClass } from "@/components/ui/styles";
import { scanPrimary, scanSecondary } from "./styles";
import { useBarcodeScanner } from "./use-barcode-scanner";

export function BarcodeScanner({
  onCode,
  manualLabel = "Look up",
  submitDisabled = false,
}: {
  onCode: (code: string, source: "camera" | "manual") => void;
  manualLabel?: string;
  submitDisabled?: boolean;
}) {
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const helpId = useId();
  const [manual, setManual] = useState("");
  const { videoRef, phase, message, torchOn, torchSupported, toggleTorch, retry } = useBarcodeScanner((code) => {
    onCodeRef.current(code, "camera");
  });

  useEffect(() => {
    if (phase === "scanning" || phase === "starting") return;
    inputRef.current?.focus();
  }, [phase]);

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = manual.trim();
    if (!code || submitDisabled) return;
    onCode(code, "manual");
  }

  const statusText = phase === "starting" ? "Starting camera…" : message;

  return (
    <div className="space-y-3">
      <div className="relative aspect-[4/3] w-full max-h-[50svh] overflow-hidden rounded-card border border-border bg-surface">
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          autoPlay
          muted
          playsInline
          aria-label="Camera viewfinder"
        />
        {phase !== "scanning" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface p-4 text-center">
            <p role={phase === "denied" ? "alert" : "status"} className="text-sm text-foreground">
              {statusText}
            </p>
            {phase !== "starting" && (
              <button type="button" onClick={retry} className={`${scanSecondary} max-w-xs`}>
                Try camera again
              </button>
            )}
          </div>
        )}
      </div>
      {phase === "scanning" && message && (
        <p role="status" className="text-sm font-medium text-danger">
          {message}
        </p>
      )}
      {torchSupported && phase === "scanning" && (
        <button
          type="button"
          onClick={() => void toggleTorch()}
          aria-pressed={torchOn}
          className={scanSecondary}
        >
          {torchOn ? "Turn light off" : "Turn light on"}
        </button>
      )}
      <form onSubmit={submitManual} className="space-y-3">
        <label className={labelClass} htmlFor={inputId}>
          <span>Manual code</span>
          <input
            ref={inputRef}
            id={inputId}
            name="code"
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            maxLength={64}
            className={`${inputClass} font-mono`}
            placeholder="Barcode or SKU"
            aria-describedby={helpId}
          />
        </label>
        <p id={helpId} className="text-sm text-muted">
          USB and Bluetooth scanners can type here. The camera picture stays on this phone.
        </p>
        <button type="submit" disabled={submitDisabled || manual.trim().length === 0} className={scanPrimary}>
          {manualLabel}
        </button>
      </form>
    </div>
  );
}

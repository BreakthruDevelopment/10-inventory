"use client";

import { useEffect, useRef, useState } from "react";
import { CAMERA_COPY, classifyCameraError, type CameraProblem } from "./camera";
import { openCamera, type CameraSession } from "./open-camera";

export type ScannerPhase = "starting" | "scanning" | CameraProblem;

const REPEAT_MS = 1500;

export function useBarcodeScanner(onCode: (code: string) => void) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);
  const sessionRef = useRef<CameraSession | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<ScannerPhase>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stopped = false;
    let session: CameraSession | null = null;
    let lastCode = "";
    let lastAt = 0;
    const isStopped = () => stopped;
    const stop = () => {
      stopped = true;
      session?.stop();
      session = null;
      sessionRef.current = null;
    };
    const onPageHide = () => stop();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setAttempt((n) => n + 1);
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    void openCamera(
      video,
      (code) => {
        if (stopped) return;
        const value = code.trim();
        if (!value) return;
        const now = Date.now();
        if (value === lastCode && now - lastAt < REPEAT_MS) return;
        lastCode = value;
        lastAt = now;
        onCodeRef.current(value);
      },
      isStopped,
    ).then(
      (opened) => {
        if (stopped) {
          opened.stop();
          return;
        }
        session = opened;
        sessionRef.current = opened;
        setPhase("scanning");
        setTorchSupported(opened.torchSupported);
        setTorchOn(false);
        setMessage(null);
      },
      (err: unknown) => {
        if (stopped) return;
        const problem = classifyCameraError(err);
        setPhase(problem);
        setTorchSupported(false);
        setTorchOn(false);
        setMessage(CAMERA_COPY[problem]);
      },
    );
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      stop();
    };
  }, [attempt]);

  async function toggleTorch() {
    const session = sessionRef.current;
    if (!session?.torchSupported) return;
    const next = !torchOn;
    try {
      await session.setTorch(next);
      setTorchOn(next);
    } catch {
      setMessage("The light isn't available on this camera.");
    }
  }

  function retry() {
    setPhase("starting");
    setMessage(null);
    setTorchOn(false);
    setTorchSupported(false);
    setAttempt((n) => n + 1);
  }

  return { videoRef, phase, message, torchOn, torchSupported, toggleTorch, retry };
}

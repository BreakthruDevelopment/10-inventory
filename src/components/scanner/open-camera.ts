import { CAMERA_ATTEMPTS, releasePreview, setTrackTorch, torchAvailable } from "./camera";
import { SCAN_FORMATS, zxingFormats } from "./formats";

export type CameraSession = {
  torchSupported: boolean;
  setTorch: (on: boolean) => Promise<void>;
  stop: () => void;
};

type DetectedBarcode = { rawValue?: string };
type BarcodeDetectorInstance = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

const emptySession: CameraSession = {
  torchSupported: false,
  setTorch: async () => {},
  stop: () => {},
};

function nativeDetector(): BarcodeDetectorInstance | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (typeof ctor !== "function") return null;
  try {
    return new ctor({ formats: [...SCAN_FORMATS] });
  } catch {
    return null;
  }
}

function prepareVideo(video: HTMLVideoElement): void {
  video.muted = true;
  video.defaultMuted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "true");
  video.setAttribute("muted", "true");
}

async function acquireCamera(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    const error = new Error("This browser can't open the camera.");
    error.name = "NotSupportedError";
    throw error;
  }
  let last: unknown;
  for (const constraints of CAMERA_ATTEMPTS) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      last = err;
      const name = typeof err === "object" && err !== null && "name" in err ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") throw err;
    }
  }
  throw last instanceof Error ? last : new Error("The camera did not start.");
}

function startNative(
  video: HTMLVideoElement,
  stream: MediaStream,
  detector: BarcodeDetectorInstance,
  onCode: (code: string) => void,
  isStopped: () => boolean,
): CameraSession {
  prepareVideo(video);
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  const track = stream.getVideoTracks()[0];
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let stopped = false;
  timer = setInterval(() => {
    if (stopped || busy || isStopped() || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    busy = true;
    void detector
      .detect(video)
      .then((codes) => {
        if (stopped || isStopped()) return;
        const value = codes.find((code) => code.rawValue)?.rawValue;
        if (value) onCode(value);
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, 250);
  return {
    torchSupported: track ? torchAvailable(track) : false,
    setTorch: async (on) => {
      if (track) await setTrackTorch(track, on);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearInterval(timer);
      releasePreview(video, stream);
    },
  };
}

async function startZxing(
  video: HTMLVideoElement,
  stream: MediaStream,
  onCode: (code: string) => void,
  isStopped: () => boolean,
): Promise<CameraSession> {
  // iPhone Safari has no BarcodeDetector. Load the decoder only in that case.
  const { BrowserMultiFormatReader, BarcodeFormat } = await import("@zxing/browser");
  if (isStopped()) {
    releasePreview(video, stream);
    return emptySession;
  }
  prepareVideo(video);
  const reader = new BrowserMultiFormatReader(undefined, {
    delayBetweenScanAttempts: 300,
    delayBetweenScanSuccess: 1200,
  });
  reader.possibleFormats = zxingFormats(BarcodeFormat);
  const track = stream.getVideoTracks()[0];
  let controls: { stop: () => void; switchTorch?: (on: boolean) => Promise<void> };
  try {
    controls = await reader.decodeFromStream(stream, video, (result) => {
      if (!result || isStopped()) return;
      onCode(result.getText());
    });
  } catch (err) {
    releasePreview(video, stream);
    throw err;
  }
  if (isStopped()) {
    try {
      controls.stop();
    } catch {
      releasePreview(video, stream);
    }
    return emptySession;
  }
  const zxingTorch = typeof controls.switchTorch === "function";
  const nativeTorch = track ? torchAvailable(track) : false;
  return {
    torchSupported: zxingTorch || nativeTorch,
    setTorch: async (on) => {
      if (controls.switchTorch) {
        await controls.switchTorch(on);
        return;
      }
      if (track) await setTrackTorch(track, on);
    },
    stop() {
      try {
        const done = controls.stop() as void | Promise<void>;
        if (done && typeof (done as Promise<void>).then === "function") {
          void (done as Promise<void>).catch(() => releasePreview(video, stream));
        }
      } catch {
        releasePreview(video, stream);
      }
    },
  };
}

/**
 * Open the rear camera and decode frames in the browser.
 * `BarcodeDetector` when the browser has it; otherwise a lazy `@zxing/browser` import.
 * No image leaves the phone. `stop` ends the stream.
 */
export async function openCamera(
  video: HTMLVideoElement,
  onCode: (code: string) => void,
  isStopped: () => boolean,
): Promise<CameraSession> {
  const stream = await acquireCamera();
  if (isStopped()) {
    releasePreview(video, stream);
    return emptySession;
  }
  const detector = nativeDetector();
  if (detector) return startNative(video, stream, detector, onCode, isStopped);
  return startZxing(video, stream, onCode, isStopped);
}

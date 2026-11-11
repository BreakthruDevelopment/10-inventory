/** Why the camera did not start. Manual entry stays available for every one of these. */
export const CAMERA_PROBLEMS = ["denied", "missing", "busy", "unsupported"] as const;
export type CameraProblem = (typeof CAMERA_PROBLEMS)[number];

export const CAMERA_COPY: Record<CameraProblem, string> = {
  denied: "Camera access is off. Type the code instead, or allow the camera for this site.",
  missing: "No camera was found. Type the code instead.",
  busy: "The camera is in use by another app. Type the code, or try again.",
  unsupported: "This browser can't open the camera. Type the code instead.",
};

type StoppableTrack = { stop: () => void; readyState?: string };
type StoppableStream = { getTracks: () => StoppableTrack[] };

function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null && "name" in err && typeof err.name === "string") return err.name;
  return "";
}

export function classifyCameraError(err: unknown): CameraProblem {
  const name = errorName(err);
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "unsupported";
}

/** Stop every track. A second call is safe after the browser has already ended them. */
export function stopMediaStream(stream: StoppableStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    if (track.readyState === "ended") continue;
    try {
      track.stop();
    } catch {
      // The track was already stopped by the decoder that owned the stream.
    }
  }
}

type Preview = { srcObject: unknown };

/** Drop the preview and stop the tracks so the camera light goes off. */
export function releasePreview(video: Preview | null | undefined, stream: StoppableStream | null | undefined): void {
  if (video) video.srcObject = null;
  stopMediaStream(stream);
}

export function torchAvailable(track: { getCapabilities?: () => unknown }): boolean {
  try {
    const caps = track.getCapabilities?.();
    if (!caps || typeof caps !== "object") return false;
    return "torch" in caps && Boolean((caps as { torch?: boolean }).torch);
  } catch {
    return false;
  }
}

export async function setTrackTorch(track: MediaStreamTrack, on: boolean): Promise<void> {
  // `torch` is not in the DOM lib's constraint types. Chrome and Android expose it at runtime.
  const constraints = { advanced: [{ torch: on }] } as unknown as MediaTrackConstraints;
  await track.applyConstraints(constraints);
}

/** Rear camera when the phone has one; otherwise whatever camera the browser will open. */
export const CAMERA_ATTEMPTS: MediaStreamConstraints[] = [
  { audio: false, video: { facingMode: { ideal: "environment" } } },
  { audio: false, video: true },
];

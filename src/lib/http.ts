import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { BadRequestError, ClientOpReusedError, HttpError, PayloadTooLargeError, StockConflictError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";

export type ErrorInfo = { status: number; body: { error: string; issues?: unknown; current?: unknown; movements?: unknown; truncated?: boolean; code?: string } };

/** Map known errors to a status and a client-safe body; never leak stack traces or internals. */
export function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof StockConflictError) {
    return { status: 409, body: { error: err.message, current: err.current, movements: err.movements, truncated: err.truncated } };
  }
  if (err instanceof ClientOpReusedError) return { status: 409, body: { error: err.message, code: err.code } };
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err instanceof HttpError) {
    return { status: err.status, body: { error: err.message } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: "Invalid input",
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    };
  }
  if (isLastManagerViolation(err)) {
    return { status: 409, body: { error: "A workspace needs at least one manager." } };
  }
  if (err instanceof AiError) {
    const status = err.kind === "input_rejected" ? 400 : err.kind === "quota" ? 429 : 502;
    return { status, body: { error: err.message } };
  }
  // Never log `err.message` here: database errors embed the query parameters (emails, note text, keys).
  log.error("request.failed", safeErrorFields(err));
  return { status: 500, body: { error: "Something went wrong" } };
}

/** The database trigger from migration 0004 (SQLSTATE 23514, constraint `membership_last_manager`), possibly wrapped by Drizzle. */
function isLastManagerViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (x.code === "23514" && (x.constraint_name === "membership_last_manager" || x.constraint === "membership_last_manager")) return true;
  }
  return false;
}

export function errorResponse(err: unknown): Response {
  const { status, body } = errorInfo(err);
  return Response.json(body, { status });
}

/** Default cap for JSON bodies: small forms and upload requests. Pass a bigger `limit` per route if you need it. */
export const JSON_BODY_LIMIT = 16 * 1024;

/**
 * Read the request body exactly once, as bytes, refusing anything over `limit` bytes.
 * Checks Content-Length first, then counts while streaming so a lying header can't get past.
 */
export async function readBodyCapped(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError(limit);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Parse a UTF-8 JSON body; 400 when it isn't valid JSON. */
export function parseJsonBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BadRequestError("Body must be valid JSON");
  }
}

/** Capped read plus JSON parse: 413 when too large, 400 when not JSON. */
export async function readJson(request: Request, limit: number = JSON_BODY_LIMIT): Promise<unknown> {
  return parseJsonBody(await readBodyCapped(request, limit));
}

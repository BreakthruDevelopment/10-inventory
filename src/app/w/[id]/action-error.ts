import "server-only";
import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { HttpError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";

/** A message safe to show on a form. Unknown failures are logged without query parameters and replaced. */
export function actionError(err: unknown, event: string): string {
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Invalid input";
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err instanceof HttpError || err instanceof AiError) {
    return err.message;
  }
  log.error(event, safeErrorFields(err));
  return "Something went wrong";
}

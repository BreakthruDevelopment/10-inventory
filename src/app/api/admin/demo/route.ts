import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/admin/demo (admin): replace the demo users' workspace ("Demo Corner Store": 1 manager, 2 staff).
 * Bodyless, so callers can't choose credentials. 1 per minute and 5 per UTC day, app-wide. Answers counts only.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await requireRole("admin");
    return Response.json(await loadDemoWorkspace(actor, { mode: "admin" }, { reserve: true }));
  } catch (err) {
    return errorResponse(err);
  }
}

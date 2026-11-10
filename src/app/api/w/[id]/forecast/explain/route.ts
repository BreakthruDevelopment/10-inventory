import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { explainForecast } from "@/lib/forecast-service";
import { errorResponse } from "@/lib/http";
export const dynamic = "force-dynamic";
// The provider timeout is 20 s (AI_TIMEOUT_MS), so the route gets 25 s.
export const maxDuration = 25;
type Ctx = { params: Promise<{ id: string }> };
/** Manager only, on request. Serves the cached explanation for the same numbers, otherwise makes one model call. No request body. */
export async function POST(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser();
    const { id } = await ctx.params;
    return Response.json(await explainForecast(actor, id), { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}

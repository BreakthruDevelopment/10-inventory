import { requireUser } from "@/lib/auth/session";
import { getForecast } from "@/lib/forecast-service";
import { errorResponse } from "@/lib/http";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
/** Manager only. Computes the forecast numbers from the ledger; never calls a model. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const actor = await requireUser();
    const { id } = await ctx.params;
    return Response.json(await getForecast(actor, id), { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}

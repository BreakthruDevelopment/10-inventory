import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { recordMovement } from "@/lib/movements";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function POST(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ movement: await recordMovement(actor, id, await readJson(request)) });
  } catch (err) { return errorResponse(err); }
}

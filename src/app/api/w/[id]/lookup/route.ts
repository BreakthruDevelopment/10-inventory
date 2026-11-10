import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { lookupItem } from "@/lib/items";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(request: Request, ctx: Ctx) {
  try {
    const actor = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ item: await lookupItem(actor, id, new URL(request.url).searchParams.get("code")) }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}

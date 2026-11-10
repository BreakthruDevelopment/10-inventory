import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { archiveItem, editItem, getItem } from "@/lib/items";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; itemId: string }> };
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const actor = await requireUser();
    const { id, itemId } = await ctx.params;
    return Response.json({ item: await getItem(actor, id, itemId) }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser();
    const { id, itemId } = await ctx.params;
    return Response.json({ item: await editItem(actor, id, itemId, await readJson(request)) });
  } catch (err) { return errorResponse(err); }
}
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser();
    const { id, itemId } = await ctx.params;
    return Response.json({ item: await archiveItem(actor, id, itemId, await readJson(request)) });
  } catch (err) { return errorResponse(err); }
}

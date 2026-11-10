import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createItem, listItems } from "@/lib/items";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(request: Request, ctx: Ctx) {
  try {
    const actor = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ items: await listItems(actor, id, Object.fromEntries(new URL(request.url).searchParams)) }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}
export async function POST(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const actor = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ item: await createItem(actor, id, await readJson(request)) }, { status: 201 });
  } catch (err) { return errorResponse(err); }
}

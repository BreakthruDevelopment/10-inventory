import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { exportItems } from "@/lib/inventory-export";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const actor = await requireUser();
    const { id } = await ctx.params;
    return new Response(await exportItems(actor, id, true), { headers: {
      "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="reorder.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff",
    } });
  } catch (err) { return errorResponse(err); }
}

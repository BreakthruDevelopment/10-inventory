import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { listMembers } from "@/lib/members";

export const dynamic = "force-dynamic";

/** GET /api/w/:id/members (manager). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ members: await listMembers(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

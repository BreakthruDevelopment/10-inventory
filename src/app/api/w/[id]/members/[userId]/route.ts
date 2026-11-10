import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { changeMemberRole, removeMember } from "@/lib/members";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; userId: string }> };

/** PATCH /api/w/:id/members/:userId (manager): { role }. The last manager can't be demoted (409). */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id, userId } = await ctx.params;
    return Response.json({ member: await changeMemberRole(user, id, userId, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/w/:id/members/:userId: a manager removes anyone; any member may remove themselves (leave). */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id, userId } = await ctx.params;
    await removeMember(user, id, userId);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}

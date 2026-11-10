import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { getWorkspace } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/** GET /api/w/:id (staff): the workspace and the caller's role in it. Non-members get 404. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ workspace: await getWorkspace(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { acceptInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

/**
 * POST /api/join/:token (any signed-in user): accept an invite. 200 { workspaceId, role, joined }; `joined: false`
 * when already a member (nothing changed). Any invalid, expired, revoked or used link is the same 404.
 */
export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { token } = await ctx.params;
    return Response.json(await acceptInvite(user, token), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { revokeInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

/** DELETE /api/w/:id/invites/:inviteId (manager): revoke. Revoking twice is a no-op. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string; inviteId: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id, inviteId } = await ctx.params;
    await revokeInvite(user, id, inviteId);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}

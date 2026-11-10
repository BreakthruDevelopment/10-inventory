import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { JSON_BODY_LIMIT, errorResponse, parseJsonBody, readBodyCapped } from "@/lib/http";
import { createInvite, listInvites } from "@/lib/invites";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/w/:id/invites (manager): states and expiry, never the links. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ invites: await listInvites(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/w/:id/invites (manager): { role? } -> { invite, token, url }. The link is shown once. */
export async function POST(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { id } = await ctx.params;
    // The body is optional ({} means a staff invite); a present body must be valid JSON within the 16 KB cap.
    const bytes = await readBodyCapped(request, JSON_BODY_LIMIT);
    const body = bytes.length === 0 ? {} : parseJsonBody(bytes);
    return Response.json(await createInvite(user, id, body), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

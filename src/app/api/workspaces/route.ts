import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createWorkspace, listMyWorkspaces } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/** GET /api/workspaces: the caller's own workspaces (those they're a member of). */
export async function GET() {
  try {
    return Response.json({ workspaces: await listMyWorkspaces(await requireUser()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/workspaces: { name, timeZone? }. The caller becomes its manager. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json({ workspace: await createWorkspace(user, await readJson(request)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

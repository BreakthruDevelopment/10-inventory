import { adminStats } from "@/lib/admin-stats";
import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats (admin): aggregate counts and caps only. No names, emails or stock. */
export async function GET() {
  try {
    return Response.json({ stats: await adminStats(await requireRole("admin")) });
  } catch (err) {
    return errorResponse(err);
  }
}

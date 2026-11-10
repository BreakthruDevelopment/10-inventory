import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageIntro } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { getWorkspace } from "@/lib/workspaces";
import { ScanScreen } from "./scan-screen";

export const metadata: Metadata = { title: "Scan", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function ScanPage({ params }: PageProps<"/w/[id]/scan">) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  const workspace = await getWorkspace(user, id).catch((err: unknown) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return (
    <>
      <PageIntro
        section="Scan"
        title="Scan"
        description="Point the rear camera at a barcode, or type the code. Nothing from the camera leaves this phone."
      />
      <ScanScreen workspaceId={workspace.id} workspaceName={workspace.name} canCreate={workspace.role === "manager"} />
    </>
  );
}

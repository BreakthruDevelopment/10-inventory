import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageIntro, Panel } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth/session";
import { JoinForm } from "./join-form";

export const metadata: Metadata = { title: "Join a workspace", robots: { index: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/** The page only asks; accepting is a POST (a server action), so a link preview or crawler can't use up an invite. */
export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/join/${token}`)}`);
  return (
    <div className="mx-auto max-w-md">
      <PageIntro section="Invite" title="Join a workspace" description={`You're signed in as ${user.email}.`} />
      <Panel title="Accept this invite">
        <p className="mb-4 text-muted">You will join the team that sent you this link, with the role they chose.</p>
        <JoinForm token={token} />
      </Panel>
    </div>
  );
}

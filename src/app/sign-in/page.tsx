import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in", referrer: "no-referrer" };

/** Only our own invite links are valid sign-in destinations; anything else falls back to the workspace list. */
function safeNext(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return v && /^\/join\/[A-Za-z0-9_-]{43}$/.test(v) ? v : "/workspaces";
}

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const next = safeNext((await searchParams).next);
  return (
    <div className="mx-auto max-w-md">
      <PageIntro section="Account" title="Sign in" description="Use your email and password, or create an account." />
      <Panel title="Your account">
        <SignInForm next={next} />
      </Panel>
    </div>
  );
}

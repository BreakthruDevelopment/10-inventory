import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { ScannerTest } from "./scanner-test-client";

export const metadata: Metadata = { title: "Scanner test", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Dev-only harness for the camera. Production answers 404 so the page is not a public scanner. */
export default async function ScannerTestPage() {
  if (process.env.NODE_ENV === "production") notFound();
  await requireUserOrRedirect();
  return (
    <>
      <PageIntro section="Development" title="Scanner test" description="Check a barcode read without recording stock." />
      <Panel title="Camera">
        <ScannerTest />
      </Panel>
    </>
  );
}

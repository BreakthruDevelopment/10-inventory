import Link from "next/link";
import { PageIntro, Panel, buttonPrimary, buttonSecondary } from "@/components/ui";

const features = [
  { title: "Counts that stay right", body: "Receive, sell, adjust and count. Every change goes in a ledger, and two people on one item can't overwrite each other." },
  { title: "Scan or type", body: "Use the phone camera to scan a barcode, or type a code or SKU. No scanner to buy." },
  { title: "Your team only", body: "Stock belongs to a workspace. Managers invite staff with a link, and no shop ever sees another's stock." },
  { title: "Forecasts you can check", body: "See when each item will run out and what to reorder, with the numbers behind it and a plain-language explanation." },
];

export default function Home() {
  return (
    <>
      <PageIntro
        section="Inventory"
        title="Stock counts that stay right."
        description="For small shops, cafés and warehouses: scan, count and reorder with a history for every item. Sign in, create a workspace for your shop, and invite your team."
        actions={
          <>
            <Link href="/sign-in" className={buttonPrimary}>
              Sign in or create an account
            </Link>
            <Link href="/workspaces" className={buttonSecondary}>
              Your workspaces
            </Link>
          </>
        }
      />
      <div className="grid gap-x-4 sm:grid-cols-2">
        {features.map((f) => (
          <Panel key={f.title} title={f.title}>
            <p className="text-muted">{f.body}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}

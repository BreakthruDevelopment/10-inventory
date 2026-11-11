import type { Metadata } from "next";
import Link from "next/link";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { listItems } from "@/lib/items";
import { listRecentMovements } from "@/lib/movements";
import { CodeLookup } from "./code-lookup";
import { formatWhen, KIND_LABEL, signedDelta } from "./format";
import { LeaveWorkspace } from "./leave-button";
import { requireWorkspacePage } from "./load";
import { WorkspaceChrome } from "./workspace-chrome";

export const metadata: Metadata = { title: "Workspace" };
export const dynamic = "force-dynamic";

type Movement = Awaited<ReturnType<typeof listRecentMovements>>[number];
type StockItem = Awaited<ReturnType<typeof listItems>>[number];

export default async function WorkspacePage({ params }: PageProps<"/w/[id]">) {
  const { id } = await params;
  const { user, workspace } = await requireWorkspacePage(id);
  const [items, movements] = await Promise.all([listItems(user, workspace.id), listRecentMovements(user, workspace.id)]);
  const low = items
    .filter((item) => item.onHand <= item.reorderPoint)
    .sort((a, b) => a.onHand - b.onHand || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const manager = workspace.role === "manager";

  const lowColumns: Column<StockItem>[] = [
    {
      key: "name",
      header: "Item",
      primary: true,
      cell: (item) => (
        <Link href={`/w/${workspace.id}/items/${item.id}`} className="font-semibold text-accent break-words underline-offset-2 hover:underline">
          {item.name}
        </Link>
      ),
    },
    { key: "sku", header: "SKU", className: "font-mono text-sm", cell: (item) => item.sku },
    {
      key: "onHand",
      header: "On hand",
      cell: (item) => (
        <span>
          {item.onHand.toLocaleString("en")} <span className="text-muted">{item.unit}</span>
        </span>
      ),
    },
    { key: "reorder", header: "Reorder point", cell: (item) => item.reorderPoint.toLocaleString("en") },
  ];

  const movementColumns: Column<Movement>[] = [
    {
      key: "item",
      header: "Item",
      primary: true,
      cell: (row) => (
        <Link href={`/w/${workspace.id}/items/${row.itemId}`} className="font-semibold text-accent break-words underline-offset-2 hover:underline">
          {row.itemName}
        </Link>
      ),
    },
    {
      key: "kind",
      header: "Movement",
      cell: (row) => (
        <span>
          {KIND_LABEL[row.kind] ?? row.kind} {signedDelta(row.delta)}
          {row.reason ? <span className="block text-muted">{row.reason}</span> : null}
        </span>
      ),
    },
    { key: "after", header: "On hand after", cell: (row) => row.onHandAfter.toLocaleString("en") },
    {
      key: "when",
      header: "When",
      className: "whitespace-nowrap",
      cell: (row) => formatWhen(row.createdAt, workspace.timeZone),
    },
  ];

  return (
    <WorkspaceChrome id={workspace.id}>
      <PageIntro
        section="Workspace"
        title={workspace.name}
        description={`You are ${manager ? "a manager" : "staff"}. Times use ${workspace.timeZone}.`}
        actions={
          <>
            <Link href={`/w/${workspace.id}/scan`} className={`${buttonPrimary} min-h-14 w-full px-6 text-base sm:w-auto`}>
              Scan
            </Link>
            <Link href={`/w/${workspace.id}/items`} className={`${buttonSecondary} w-full sm:w-auto`}>
              Items
            </Link>
            {manager && (
              <Link href={`/w/${workspace.id}/forecast`} className={`${buttonSecondary} w-full sm:w-auto`}>
                Forecast
              </Link>
            )}
          </>
        }
      />
      <StatGrid>
        <StatTile value={items.length.toLocaleString("en")} label="Active items" tone="accent" />
        <StatTile value={low.length.toLocaleString("en")} label="At or below reorder point" tone={low.length > 0 ? "blocked" : "live"} />
      </StatGrid>
      <Panel title="Find an item">
        <p className="text-muted">Scan uses the phone camera. You can also type a barcode or SKU.</p>
        <CodeLookup workspaceId={workspace.id} />
      </Panel>
      <Panel title="Low stock" count={low.length}>
        <DataList
          caption="Items at or below their reorder point"
          rows={low}
          rowKey={(item) => item.id}
          columns={lowColumns}
          empty="Nothing is at or below its reorder point."
        />
      </Panel>
      <Panel title="Recent movements" count={movements.length}>
        <DataList
          caption="Recent stock movements"
          rows={movements}
          rowKey={(row) => row.id}
          columns={movementColumns}
          empty="No stock movements yet. Open an item to receive a delivery."
        />
      </Panel>
      <Panel title="Your membership">
        <p className="mb-3 text-muted">Leaving removes your access. A workspace always keeps one manager.</p>
        <LeaveWorkspace workspaceId={workspace.id} />
      </Panel>
    </WorkspaceChrome>
  );
}

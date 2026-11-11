import type { Metadata } from "next";
import Link from "next/link";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatusBadge } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { listItems } from "@/lib/items";
import { queryValue } from "../format";
import { requireWorkspacePage } from "../load";
import { WorkspaceChrome } from "../workspace-chrome";
import { CreateItemForm } from "./create-item-form";

export const metadata: Metadata = { title: "Items" };
export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof listItems>>[number];

export default async function ItemsPage({ params, searchParams }: PageProps<"/w/[id]/items">) {
  const { id } = await params;
  const { user, workspace } = await requireWorkspacePage(id);
  const sp = await searchParams;
  const q = queryValue(sp.q).slice(0, 120);
  const archived = queryValue(sp.archived) === "true" ? "true" : "false";
  const rows = await listItems(user, workspace.id, { q, archived });
  const manager = workspace.role === "manager";

  const columns: Column<Row>[] = [
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
    { key: "sku", header: "SKU", className: "font-mono text-sm", cell: (item) => <span className="font-mono break-all">{item.sku}</span> },
    {
      key: "onHand",
      header: "On hand",
      cell: (item) => (
        <span className="inline-flex flex-wrap items-center justify-end gap-2 sm:justify-start">
          <span>
            {item.onHand.toLocaleString("en")} <span className="text-muted">{item.unit}</span>
          </span>
          {archived === "false" && item.onHand <= item.reorderPoint && <StatusBadge status="blocked" label="Low" />}
        </span>
      ),
    },
    { key: "reorder", header: "Reorder point", cell: (item) => item.reorderPoint.toLocaleString("en") },
  ];

  return (
    <WorkspaceChrome id={workspace.id}>
      <PageIntro
        section="Items"
        title="Items"
        description={manager ? "Search stock, or add an item. New items start at zero." : "Search stock and open an item to record a delivery, a sale or a count."}
        actions={
          manager ? (
            <>
              <a href={`/api/w/${workspace.id}/export/items.csv`} className={buttonSecondary}>
                Download items (CSV)
              </a>
              <a href={`/api/w/${workspace.id}/export/reorder.csv`} className={buttonSecondary}>
                Download reorder list (CSV)
              </a>
            </>
          ) : undefined
        }
      />
      <FilterBar
        label="Filter items"
        search={{ value: q, placeholder: "Name, SKU or barcode" }}
        filters={[
          {
            name: "archived",
            label: "Which items",
            value: archived,
            options: [
              { value: "false", label: "Active" },
              { value: "true", label: "Archived" },
            ],
          },
        ]}
      />
      <Panel title={archived === "true" ? "Archived items" : "Active items"} count={rows.length}>
        <DataList
          caption="Items"
          rows={rows}
          rowKey={(item) => item.id}
          columns={columns}
          empty={q ? "No items match that search." : archived === "true" ? "No archived items." : "No items yet."}
        />
      </Panel>
      {manager && archived === "false" && (
        <Panel title="New item">
          <CreateItemForm workspaceId={workspace.id} />
        </Panel>
      )}
    </WorkspaceChrome>
  );
}

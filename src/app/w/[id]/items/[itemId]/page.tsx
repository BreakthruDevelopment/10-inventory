import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { type Column, DataList, PageIntro, Panel, StatusBadge } from "@/components/ui";
import { NotFoundError } from "@/lib/errors";
import { getItem } from "@/lib/items";
import { formatCost, formatWhen, KIND_LABEL, signedDelta, UNIT_LABEL } from "../../format";
import { requireWorkspacePage } from "../../load";
import { WorkspaceChrome } from "../../workspace-chrome";
import { ArchiveItemForm, EditItemForm } from "./edit-form";
import { StockForm } from "./stock-form";

export const metadata: Metadata = { title: "Item" };
export const dynamic = "force-dynamic";

type Movement = Awaited<ReturnType<typeof getItem>>["movements"][number];

export default async function ItemPage({ params }: PageProps<"/w/[id]/items/[itemId]">) {
  const { id, itemId } = await params;
  const { user, workspace } = await requireWorkspacePage(id);
  const item = await getItem(user, workspace.id, itemId).catch((err: unknown) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  if (!item) notFound();
  const manager = workspace.role === "manager";
  const archived = item.archivedAt != null;

  const columns: Column<Movement>[] = [
    {
      key: "kind",
      header: "Movement",
      primary: true,
      cell: (row) => (
        <span>
          {KIND_LABEL[row.kind] ?? row.kind} {signedDelta(row.delta)}
          {row.reason ? <span className="block font-normal text-muted">{row.reason}</span> : null}
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

  const facts: { label: string; value: string }[] = [
    { label: "SKU", value: item.sku },
    { label: "On hand", value: `${item.onHand.toLocaleString("en")} ${UNIT_LABEL[item.unit] ?? item.unit}` },
    { label: "Reorder point", value: item.reorderPoint.toLocaleString("en") },
    { label: "Lead time", value: `${item.leadTimeDays} days` },
    { label: "Pack size", value: item.packSize.toLocaleString("en") },
    { label: "Unit cost", value: formatCost(item.unitCostCents) },
  ];
  if (item.barcode) facts.splice(1, 0, { label: "Barcode", value: item.barcode });
  if (item.supplierName) facts.push({ label: "Supplier", value: item.supplierName });

  return (
    <WorkspaceChrome id={workspace.id}>
      <PageIntro
        section="Item"
        title={item.name}
        description={archived ? "Archived. History stays, and stock can no longer change." : `Version ${item.version}.`}
        actions={
          <span className="inline-flex flex-wrap gap-2">
            {item.ledgerMatches ? <StatusBadge status="healthy" label="Ledger matches" /> : <StatusBadge status="down" label="Ledger does not match" />}
            {archived && <StatusBadge status="not-started" label="Archived" />}
            {!archived && item.onHand <= item.reorderPoint && <StatusBadge status="blocked" label="Low" />}
          </span>
        }
      />
      <Panel title="Stock">
        <dl className="mb-4 grid gap-3 sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="text-sm text-muted">{fact.label}</dt>
              <dd className={`break-words ${fact.label === "SKU" || fact.label === "Barcode" ? "font-mono" : ""}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mb-4 text-sm text-muted">
          Ledger sum {item.ledgerBalance.toLocaleString("en")}. {item.ledgerMatches ? "It matches the balance." : "It does not match the balance."}
        </p>
        {!archived && (
          <StockForm workspaceId={workspace.id} item={{ id: item.id, unit: item.unit, onHand: item.onHand, version: item.version }} />
        )}
      </Panel>
      <Panel title="History" count={item.movements.length}>
        <DataList
          caption="Stock history"
          rows={item.movements}
          rowKey={(row) => row.id}
          columns={columns}
          empty="No movements yet."
        />
        {item.movements.length === 200 && <p className="mt-3 text-sm text-muted">Showing the latest 200 movements.</p>}
      </Panel>
      {manager && !archived && (
        <Panel title="Edit item">
          <EditItemForm
            key={item.version}
            workspaceId={workspace.id}
            item={{
              id: item.id,
              sku: item.sku,
              name: item.name,
              barcode: item.barcode,
              unit: item.unit,
              reorderPoint: item.reorderPoint,
              leadTimeDays: item.leadTimeDays,
              packSize: item.packSize,
              supplierName: item.supplierName,
              unitCostCents: item.unitCostCents,
              version: item.version,
            }}
          />
        </Panel>
      )}
      {manager && !archived && (
        <Panel title="Archive">
          <ArchiveItemForm workspaceId={workspace.id} itemId={item.id} version={item.version} />
        </Panel>
      )}
    </WorkspaceChrome>
  );
}

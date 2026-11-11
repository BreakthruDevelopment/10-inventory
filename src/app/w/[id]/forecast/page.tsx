import type { Metadata } from "next";
import Link from "next/link";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import type { ItemForecast } from "@/lib/forecast";
import { getForecast } from "@/lib/forecast-service";
import { formatCount, formatDay, formatDecimal, formatWhen } from "../format";
import { requireWorkspacePage } from "../load";
import { ManagerOnly } from "../manager-only";
import { WorkspaceChrome } from "../workspace-chrome";
import type { ShownExplanation } from "./actions";
import { ExplainPanel } from "./explain-panel";
import { ForecastStatusChip } from "./status-chip";

export const metadata: Metadata = { title: "Forecast" };
export const dynamic = "force-dynamic";

export default async function ForecastPage({ params }: PageProps<"/w/[id]/forecast">) {
  const { id } = await params;
  const { user, workspace } = await requireWorkspacePage(id);
  if (workspace.role !== "manager") {
    return (
      <WorkspaceChrome id={workspace.id}>
        <PageIntro section="Forecast" title="Forecast" description="Reorder numbers for this workspace." />
        <ManagerOnly what="Forecast" />
      </WorkspaceChrome>
    );
  }
  const view = await getForecast(user, workspace.id);
  const names = Object.fromEntries(view.items.map((item) => [item.itemId, item.name]));
  const initial: ShownExplanation | null = view.explanation
    ? {
        overview: view.explanation.overview,
        items: view.explanation.items,
        caveats: view.explanation.caveats,
        demo: view.explanation.demo,
        createdAt: view.explanation.createdAt,
      }
    : null;

  const columns: Column<ItemForecast>[] = [
    {
      key: "name",
      header: "Item",
      primary: true,
      cell: (item) => (
        <Link href={`/w/${workspace.id}/items/${item.itemId}`} className="font-semibold text-accent break-words underline-offset-2 hover:underline">
          {item.name}
        </Link>
      ),
    },
    { key: "sku", header: "SKU", className: "font-mono text-sm", cell: (item) => <span className="font-mono break-all">{item.sku}</span> },
    {
      key: "status",
      header: "Status",
      cell: (item) => <ForecastStatusChip status={item.status} belowReorderPoint={item.belowReorderPoint} />,
    },
    {
      key: "onHand",
      header: "On hand",
      cell: (item) => (
        <span>
          {item.onHand.toLocaleString("en")} <span className="text-muted">{item.unit}</span>
        </span>
      ),
    },
    { key: "avg", header: "Avg / day", cell: (item) => formatDecimal(item.avgDaily, 2) },
    { key: "trend", header: "Trend", cell: (item) => formatDecimal(item.trend, 2) },
    { key: "cover", header: "Days of cover", cell: (item) => formatDecimal(item.daysOfCover, 1) },
    { key: "stockout", header: "Stockout", cell: (item) => formatDay(item.stockoutDate) },
    { key: "reorderBy", header: "Reorder by", cell: (item) => formatDay(item.reorderBy) },
    { key: "safety", header: "Safety stock", cell: (item) => formatCount(item.safetyStock) },
    { key: "suggested", header: "Suggested", cell: (item) => formatCount(item.suggestedQty) },
  ];

  return (
    <WorkspaceChrome id={workspace.id}>
      <PageIntro
        section="Forecast"
        title="Forecast"
        description={`From the last ${view.windowDays} days of sales in ${view.timeZone}. Computed when you open this page. Updated ${formatWhen(view.generatedAt, view.timeZone)}.`}
        actions={
          <>
            <a href={`/api/w/${workspace.id}/export/reorder.csv`} className={buttonSecondary}>
              Download reorder list (CSV)
            </a>
            <a href={`/api/w/${workspace.id}/export/items.csv`} className={buttonSecondary}>
              Download items (CSV)
            </a>
          </>
        }
      />
      <StatGrid>
        <StatTile value={view.counts.reorderNow} label="Reorder now" tone={view.counts.reorderNow > 0 ? "blocked" : "default"} />
        <StatTile value={view.counts.reorderSoon} label="Reorder soon" tone={view.counts.reorderSoon > 0 ? "building" : "default"} />
        <StatTile value={view.counts.ok} label="OK" tone="live" />
        <StatTile value={view.counts.noData} label="No sales history" />
      </StatGrid>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]">
        <Panel title="Numbers" count={view.items.length}>
          <DataList
            caption="Forecast"
            rows={view.items}
            rowKey={(item) => item.itemId}
            columns={columns}
            empty="No active items yet."
          />
        </Panel>
        <ExplainPanel
          workspaceId={workspace.id}
          timeZone={view.timeZone}
          initial={initial}
          names={names}
          needsReorder={view.counts.reorderNow + view.counts.reorderSoon > 0}
        />
      </div>
    </WorkspaceChrome>
  );
}

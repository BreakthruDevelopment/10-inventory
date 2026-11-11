import { Panel } from "@/components/ui";

/** Staff opened a manager page. The API still returns 403; this is the page they see instead of an error. */
export function ManagerOnly({ what }: { what: string }) {
  return (
    <Panel title={what}>
      <p className="text-muted">Only managers can open this page. You can still scan, look up items and record stock.</p>
    </Panel>
  );
}

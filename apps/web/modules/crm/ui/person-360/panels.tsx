/**
 * The read-only panels of the 360 page (crm spec 5.1): credits and expiry, membership, bookings,
 * waiting lists, orders, invoices, automations and segments. Each is a `ListPanel` of rows the
 * page formats on the server from the owning module's api, loaded through `safePanel()`; a panel
 * whose load failed (`rows: null`) shows "Not available yet" and the rest of the page renders.
 * Every string is a prop.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@beam/ui";
import { NotAvailable, PanelShell } from "./safe-panel";

export type PanelRow = {
  id: string;
  primary: string;
  secondary?: string | null;
  badge?: string | null;
  href?: string | null;
};

export function ListPanel({
  title,
  rows,
  empty,
  notAvailable,
  testId,
  footer,
}: {
  title: string;
  rows: PanelRow[] | null;
  empty: string;
  notAvailable: string;
  testId?: string;
  footer?: ReactNode;
}) {
  return (
    <PanelShell title={title} testId={testId}>
      {rows === null ? (
        <NotAvailable label={notAvailable} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="grid">
                {r.href ? (
                  <Link href={r.href as never} className="font-medium underline-offset-4 hover:underline">
                    {r.primary}
                  </Link>
                ) : (
                  <span className="font-medium">{r.primary}</span>
                )}
                {r.secondary ? <span className="text-muted-foreground">{r.secondary}</span> : null}
              </span>
              {r.badge ? <Badge variant="outline">{r.badge}</Badge> : null}
            </li>
          ))}
        </ul>
      )}
      {footer}
    </PanelShell>
  );
}

/** A panel whose body is another module's component (email history, automations), or "Not available yet". */
export function NodePanel({ title, node, notAvailable, testId }: { title: string; node: ReactNode | null; notAvailable: string; testId?: string }) {
  return (
    <PanelShell title={title} testId={testId}>
      {node ?? <NotAvailable label={notAvailable} />}
    </PanelShell>
  );
}

export function PanelGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

/**
 * `safePanel()` (crm spec 10, 5.1): every foreign panel of the 360 page loads through it, so a
 * sibling module that is still a `NotImplementedError` stub, or a panel that throws, renders
 * "Not available yet" for that panel only. A stub is expected and not reported; any other error
 * goes to Sentry once (scrubbed by the reporter). `PanelShell` is the card around a panel and
 * `NotAvailable` the fallback body.
 */
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { NotImplementedError } from "@beam/core/errors";
import { reportError } from "@/lib/logger";

export type SafeResult<T> = { ok: true; value: T } | { ok: false };

export async function safePanel<T>(load: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    if (!(error instanceof NotImplementedError)) reportError(error, { tags: { area: "crm.person360.panel" } });
    return { ok: false };
  }
}

/** A synchronous render (a foreign server component that throws while still a stub). */
export function safeRender(render: () => ReactNode, fallback: ReactNode): ReactNode {
  try {
    return render();
  } catch (error) {
    if (!(error instanceof NotImplementedError)) reportError(error, { tags: { area: "crm.person360.panel" } });
    return fallback;
  }
}

export function NotAvailable({ label }: { label: string }) {
  return (
    <p className="text-sm text-muted-foreground" data-testid="panel-not-available">
      {label}
    </p>
  );
}

export function PanelShell({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

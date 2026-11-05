/**
 * The registrant table of `/admin/webinars/[id]/registrations` (webinar spec 5.1): name, email,
 * status, the lead/customer/member snapshot, registered mode, source, watch minutes per mode and
 * the last activity, with Cancel, Resend link and Revoke link per row. A server-rendered table:
 * each action is a plain form posting the page's server action (`op` + `registrationId`), so it
 * works without client JavaScript. Every text arrives from the page.
 */
import type { ReactNode } from "react";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";

type WatchMode = "live" | "replay" | "on_demand";

export type RegistrationsTableRow = {
  id: string;
  name: string;
  email: string | null;
  status: "registered" | "cancelled" | "blocked";
  personStatus: "lead" | "customer" | "member";
  registeredMode: WatchMode;
  source: "site" | "portal" | "admin" | "automation";
  muted: boolean;
  watchedMinutes: Record<WatchMode, number>;
  lastActivity: string;
  personHref: string;
};

export type RegistrationsTableLabels = {
  caption: string;
  name: string;
  email: string;
  status: string;
  segment: string;
  registeredMode: string;
  source: string;
  watch: string;
  lastActivity: string;
  actions: string;
  minutes: (n: number) => string;
  muted: string;
  statuses: Record<RegistrationsTableRow["status"], string>;
  segments: Record<RegistrationsTableRow["personStatus"], string>;
  sources: Record<RegistrationsTableRow["source"], string>;
  modes: Record<WatchMode, string>;
  cancel: string;
  resend: string;
  revoke: string;
  revokeHint: string;
};

export function RegistrationsTable({
  rows,
  labels,
  action,
  canAct,
}: {
  rows: RegistrationsTableRow[];
  labels: RegistrationsTableLabels;
  /** The page's server action; reads `op` (`cancel` | `resend` | `revoke`) and `registrationId`. */
  action: (formData: FormData) => Promise<void>;
  canAct: boolean;
}) {
  const button = (row: RegistrationsTableRow, op: "cancel" | "resend" | "revoke", text: string, title?: string): ReactNode => (
    <form action={action} key={op}>
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="registrationId" value={row.id} />
      <Button type="submit" variant={op === "revoke" ? "outline" : "secondary"} size="sm" title={title} aria-label={`${text}: ${row.name}`}>
        {text}
      </Button>
    </form>
  );
  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">{labels.caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{labels.name}</TableHead>
            <TableHead scope="col">{labels.email}</TableHead>
            <TableHead scope="col">{labels.status}</TableHead>
            <TableHead scope="col">{labels.segment}</TableHead>
            <TableHead scope="col">{labels.registeredMode}</TableHead>
            <TableHead scope="col">{labels.source}</TableHead>
            <TableHead scope="col">{labels.watch}</TableHead>
            <TableHead scope="col">{labels.lastActivity}</TableHead>
            {canAct ? <TableHead scope="col">{labels.actions}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <a href={r.personHref} className="underline underline-offset-2">
                  {r.name}
                </a>
              </TableCell>
              <TableCell>{r.email ?? ""}</TableCell>
              <TableCell>
                <Badge variant={r.status === "registered" ? "secondary" : "outline"}>{labels.statuses[r.status]}</Badge>
                {r.muted ? <span className="ml-1 text-xs text-muted-foreground">({labels.muted})</span> : null}
              </TableCell>
              <TableCell>{labels.segments[r.personStatus]}</TableCell>
              <TableCell>{labels.modes[r.registeredMode]}</TableCell>
              <TableCell>{labels.sources[r.source]}</TableCell>
              <TableCell className="whitespace-nowrap">
                {labels.minutes(r.watchedMinutes.live)} / {labels.minutes(r.watchedMinutes.replay)} / {labels.minutes(r.watchedMinutes.on_demand)}
              </TableCell>
              <TableCell className="whitespace-nowrap">{r.lastActivity}</TableCell>
              {canAct ? (
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {r.status === "registered" ? [button(r, "resend", labels.resend), button(r, "revoke", labels.revoke, labels.revokeHint), button(r, "cancel", labels.cancel)] : null}
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

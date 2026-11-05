"use client";
/**
 * The campaign report of `/admin/campaigns/[id]/report` (email spec rule 61, section 5):
 * `v_campaign_stats` tiles and rates (from the frozen snapshot when present, rule 62), skipped by
 * reason, not sent (stopped), sends per 15 minutes, clicks per link, the per-locale table and the
 * bounces and complaints list; "Export CSV" (ids, statuses, open and click times).
 *
 * Also the package's other client controls: `ResendMessageButton` (message detail and the
 * person history; `persons.write`) and `CancelScheduledButton` (`email.send`).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { cancelScheduledMessage, exportCampaignReport, resendMessage } from "../actions";
import type { CampaignReport as Report } from "../server/reports";
import { formatCount, formatRate, KpiTiles, type KpiTile } from "./KpiTiles";

export type Labels = Readonly<Record<string, string>>;

/** A label with `{name}` parameters filled; the key itself when missing. */
export const lab = (labels: Labels, key: string, params: Record<string, string | number> = {}): string =>
  (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));

const errorText = (labels: Labels, error: { code: string; message?: string }) =>
  labels[`error_${error.message ?? ""}`] ?? labels[`error_${error.code}`] ?? lab(labels, "error_generic");

export function CampaignReport(props: { report: Report; locale: string; labels: Labels; localeNames: Readonly<Record<string, string>>; canExport: boolean }) {
  const { report: r, locale, labels } = props;
  const s = r.stats;
  const n = (v: number) => formatCount(locale, v);
  const pct = (v: number | null) => formatRate(locale, v);
  const time = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" });
  const skipped = Object.entries(r.skippedByReason).filter(([, v]) => v > 0);

  const tiles: KpiTile[] = [
    { key: "recipients", label: lab(labels, "tile_recipients"), value: n(s.recipients) },
    { key: "skipped", label: lab(labels, "tile_skipped"), value: n(s.skipped) },
    ...(r.campaign.status === "stopped" ? [{ key: "not_sent_stopped", label: lab(labels, "tile_not_sent_stopped"), value: n(r.notSentStopped), tone: "warning" as const }] : []),
    { key: "sent", label: lab(labels, "tile_sent"), value: n(s.sent) },
    { key: "delivered", label: lab(labels, "tile_delivered"), value: n(s.delivered) },
    {
      key: "unique_opens",
      label: lab(labels, "tile_unique_opens"),
      value: n(s.uniqueOpens),
      hint: s.privacyProxyOpens ? lab(labels, "tile_privacy_opens", { count: n(s.privacyProxyOpens) }) : null,
    },
    { key: "unique_clicks", label: lab(labels, "tile_unique_clicks"), value: n(s.uniqueClicks) },
    { key: "hard_bounced", label: lab(labels, "tile_hard_bounces"), value: n(s.hardBounced), tone: s.hardBounced ? "warning" : "default" },
    { key: "soft_bounced", label: lab(labels, "tile_soft_bounces"), value: n(s.softBounced) },
    { key: "complained", label: lab(labels, "tile_complaints"), value: n(s.complained), tone: s.complained ? "danger" : "default" },
    { key: "unsubscribed", label: lab(labels, "tile_unsubscribes"), value: n(s.unsubscribed) },
  ];
  const rates: KpiTile[] = [
    { key: "open_rate", label: lab(labels, "rate_open"), value: pct(s.openRate) },
    { key: "click_rate", label: lab(labels, "rate_click"), value: pct(s.clickRate) },
    { key: "click_to_open_rate", label: lab(labels, "rate_cto"), value: pct(s.clickToOpenRate) },
    { key: "bounce_rate", label: lab(labels, "rate_bounce"), value: pct(s.bounceRate) },
    { key: "complaint_rate", label: lab(labels, "rate_complaint"), value: pct(s.complaintRate) },
    { key: "unsubscribe_rate", label: lab(labels, "rate_unsubscribe"), value: pct(s.unsubscribeRate) },
  ];
  const maxBucket = Math.max(1, ...r.timeline.map((b) => b.sent));

  if (s.recipients === 0 && s.sent === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="report-empty">
        {r.campaign.scheduledAt ? lab(labels, "empty", { at: time.format(new Date(r.campaign.scheduledAt)) }) : lab(labels, "empty_unscheduled")}
      </p>
    );
  }

  return (
    <div className="grid gap-8" data-testid="campaign-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {r.frozenAt ? <Badge variant="secondary">{lab(labels, "frozen", { date: time.format(new Date(r.frozenAt)) })}</Badge> : <span />}
        {props.canExport ? <ExportCsvButton campaignId={r.campaign.id} labels={labels} /> : null}
      </div>
      <KpiTiles tiles={tiles} testId="report-tiles" />
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{lab(labels, "rates_title")}</h2>
        <KpiTiles tiles={rates} testId="report-rates" />
      </section>

      {skipped.length ? (
        <section className="grid gap-2">
          <h2 className="text-lg font-semibold">{lab(labels, "skipped_title")}</h2>
          <ul className="grid gap-1 text-sm">
            {skipped.map(([reason, count]) => (
              <li key={reason} className="flex justify-between gap-4 border-b py-1" data-skipped={reason}>
                <span>{lab(labels, `reason_${reason}`)}</span>
                <span className="tabular-nums">{n(count)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{lab(labels, "timeline_title")}</h2>
        {r.timeline.length ? (
          <ol className="grid gap-1 text-sm" data-testid="report-timeline">
            {r.timeline.map((b) => (
              <li key={b.at} className="grid grid-cols-[8rem_1fr_4rem] items-center gap-2">
                <span className="text-muted-foreground">{time.format(new Date(b.at))}</span>
                <span className="h-2 rounded bg-primary" style={{ width: `${Math.max(2, (100 * b.sent) / maxBucket)}%` }} aria-hidden="true" />
                <span className="text-right tabular-nums">{n(b.sent)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{lab(labels, "timeline_empty")}</p>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{lab(labels, "links_title")}</h2>
        {r.clicksByLink.length ? (
          <Table data-testid="report-links">
            <TableHeader>
              <TableRow>
                <TableHead>{lab(labels, "col_link")}</TableHead>
                <TableHead>{lab(labels, "col_url")}</TableHead>
                <TableHead className="text-right">{lab(labels, "col_unique_clicks")}</TableHead>
                <TableHead className="text-right">{lab(labels, "col_clicks")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.clicksByLink.map((l) => (
                <TableRow key={l.linkIndex} data-link-index={l.linkIndex}>
                  <TableCell>{l.linkIndex + 1}</TableCell>
                  <TableCell className="max-w-[28rem] truncate">{l.url ?? "–"}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(l.uniqueClicks)}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(l.clicks)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{lab(labels, "links_empty")}</p>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{lab(labels, "locales_title")}</h2>
        <Table data-testid="report-locales">
          <TableHeader>
            <TableRow>
              <TableHead>{lab(labels, "col_locale")}</TableHead>
              <TableHead className="text-right">{lab(labels, "col_recipients")}</TableHead>
              <TableHead className="text-right">{lab(labels, "col_sent")}</TableHead>
              <TableHead className="text-right">{lab(labels, "col_delivered")}</TableHead>
              <TableHead className="text-right">{lab(labels, "col_opens")}</TableHead>
              <TableHead className="text-right">{lab(labels, "col_locale_clicks")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.byLocale.map((l) => (
              <TableRow key={l.locale} data-locale={l.locale}>
                <TableCell>{props.localeNames[l.locale] ?? l.locale}</TableCell>
                <TableCell className="text-right tabular-nums">{n(l.recipients)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(l.sent)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(l.delivered)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(l.uniqueOpens)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(l.uniqueClicks)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{lab(labels, "bounces_title")}</h2>
        {r.bounces.length ? (
          <Table data-testid="report-bounces">
            <TableHeader>
              <TableRow>
                <TableHead>{lab(labels, "col_time")}</TableHead>
                <TableHead>{lab(labels, "col_recipient")}</TableHead>
                <TableHead>{lab(labels, "col_type")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.bounces.map((b) => (
                <TableRow key={b.emailMessageId}>
                  <TableCell>{b.at ? time.format(new Date(b.at)) : "–"}</TableCell>
                  <TableCell>{b.email ?? "–"}</TableCell>
                  <TableCell>
                    <Badge variant={b.kind === "soft" ? "secondary" : "destructive"}>{lab(labels, `type_${b.kind}`)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{lab(labels, "bounces_empty")}</p>
        )}
      </section>
    </div>
  );
}

export function ExportCsvButton(props: { campaignId: string; labels: Labels }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    const result = await exportCampaignReport({ campaignId: props.campaignId });
    setBusy(false);
    if (!result.ok) return setError(errorText(props.labels, result.error));
    const url = URL.createObjectURL(new Blob([result.data.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = result.data.filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="grid gap-1">
      <Button variant="outline" onClick={run} disabled={busy} data-testid="report-export">
        {lab(props.labels, busy ? "exporting" : "export_csv")}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/** Resend of a transactional message (`persons.write`); shows the outcome inline and refreshes. */
export function ResendMessageButton(props: { messageId: string; labels: Labels; size?: "sm" | "default" }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  async function run() {
    if (!window.confirm(lab(props.labels, "resend_confirm"))) return;
    setState("busy");
    setError(null);
    const result = await resendMessage({ messageId: props.messageId });
    if (!result.ok) {
      setState("idle");
      return setError(errorText(props.labels, result.error));
    }
    setState("done");
    router.refresh();
  }
  return (
    <span className="inline-grid gap-1">
      <Button variant="outline" size={props.size ?? "default"} onClick={run} disabled={state !== "idle"} data-testid="message-resend">
        {lab(props.labels, state === "done" ? "resend_done" : "resend")}
      </Button>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </span>
  );
}

/** Cancels a scheduled single message (rule 59, `email.send`). */
export function CancelScheduledButton(props: { messageId: string; labels: Labels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    const result = await cancelScheduledMessage({ messageId: props.messageId });
    setBusy(false);
    if (!result.ok) return setError(errorText(props.labels, result.error));
    router.refresh();
  }
  return (
    <span className="inline-grid gap-1">
      <Button variant="outline" onClick={run} disabled={busy} data-testid="message-cancel">
        {lab(props.labels, "cancel_scheduled")}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </span>
  );
}

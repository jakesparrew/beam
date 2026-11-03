/**
 * `platform.monthly_report` (PL-89): the monthly platform report for BEAM management, in each
 * recipient's `users.locale`, with the figures in the body. Counts only, no personal data.
 */
import { z } from "zod";
import { Column, Row, Section } from "react-email";
import { formatMoney, formatNumber, formatPercent, t, type Locale } from "@beam/core/i18n";
import { BRAND, EmailButton, EmailHeading, EmailLayout, EmailText } from "../../layout";
import type { TemplateComponentProps } from "../define";

const count = z.number().int().nonnegative();

export const MonthlyReportProps = z.object({
  /** The Brussels month, `YYYY-MM`. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  uptimePct: z.number().min(0).max(100).nullable(),
  uptimeSource: z.enum(["betterstack", "manual"]),
  downtimeMinutes: count,
  incidents: z.object({ critical: count, high: count, normal: count }),
  support: z.object({ received: count, resolved: count, breaches: count }),
  deadJobs: count,
  alertsSent: count,
  backupsOk: count,
  backupsFailed: count,
  aiSpendCents: count,
  notes: z.string().max(5000).default(""),
  /** `/admin/system/reports/<id>`. */
  url: z.string().url(),
});

/** Below 99.5 % the uptime shows in red (PL-89a). */
export const UPTIME_TARGET_PCT = 99.5;

function Figure({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <Row style={{ borderBottom: "1px solid #eeeae2" }}>
      <Column style={{ color: BRAND.muted, fontSize: "14px", padding: "8px 0" }}>{label}</Column>
      <Column style={{ color: alert ? "#b42318" : BRAND.text, fontSize: "14px", fontWeight: 600, padding: "8px 0", textAlign: "right" }}>{value}</Column>
    </Row>
  );
}

const label = (locale: Locale, key: string) => t(locale, `platform.email.monthly_report.${key}`);

export function MonthlyReport(props: TemplateComponentProps<typeof MonthlyReportProps>) {
  const { locale, copy } = props;
  const n = (v: number) => formatNumber(v, locale);
  const uptime =
    props.uptimePct === null
      ? "–"
      : `${formatPercent(props.uptimePct, locale, 2)}${props.uptimeSource === "manual" ? ` (${label(locale, "uptime_manual")})` : ""}`;
  return (
    <EmailLayout locale={locale} preheader={copy.preheader}>
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailText>{copy.body}</EmailText>
      <Section style={{ margin: "0 0 24px" }}>
        <Figure label={`${label(locale, "uptime")} (${label(locale, "uptime_target")})`} value={uptime} alert={props.uptimePct !== null && props.uptimePct < UPTIME_TARGET_PCT} />
        <Figure label={label(locale, "downtime")} value={n(props.downtimeMinutes)} />
        <Figure label={label(locale, "incidents")} value={`${n(props.incidents.critical)} / ${n(props.incidents.high)} / ${n(props.incidents.normal)}`} />
        <Figure label={label(locale, "support_received")} value={n(props.support.received)} />
        <Figure label={label(locale, "support_resolved")} value={n(props.support.resolved)} />
        <Figure label={label(locale, "support_breaches")} value={n(props.support.breaches)} alert={props.support.breaches > 0} />
        <Figure label={label(locale, "dead_jobs")} value={n(props.deadJobs)} />
        <Figure label={label(locale, "alerts_sent")} value={n(props.alertsSent)} />
        <Figure label={label(locale, "backups")} value={`${n(props.backupsOk)} / ${n(props.backupsFailed)}`} alert={props.backupsFailed > 0} />
        <Figure label={label(locale, "ai_spend")} value={formatMoney(props.aiSpendCents, locale)} />
      </Section>
      {props.notes.trim() ? (
        <EmailText>
          <strong>{label(locale, "notes")}:</strong> {props.notes}
        </EmailText>
      ) : null}
      <EmailButton href={props.url} locale={locale}>
        {copy.cta}
      </EmailButton>
    </EmailLayout>
  );
}

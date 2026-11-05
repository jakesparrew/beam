import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { catalogueSection, getMessage } from "@/modules/email/queries";
import { CancelScheduledButton, ResendMessageButton } from "@/modules/email/ui/CampaignReport";

const fill = (text: string, params: Record<string, string | number> = {}) => text.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));

/**
 * `/admin/email/messages/[id]` (`email.write`), email spec section 5: headers summary, status
 * history from `email_events`, and the rendered HTML kept outside production (`rendered_file_id`,
 * shown in a sandboxed frame). Resend for transactional messages (`persons.write`); cancel for a
 * scheduled single message (`email.send`, rule 59).
 */
export default async function EmailMessagePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "email.write" });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getAppDb();
  const detail = await getMessage(db, id, { unmasked: hasPermission(actor, "persons.read") });
  if (!detail) notFound();
  const locale = await adminLocale();
  const labels = catalogueSection(locale, "email.messages");
  const t = (key: string, params?: Record<string, string | number>) => fill(labels[key] ?? key, params);
  const time = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "medium" });
  const at = (d: Date | null | undefined) => (d ? time.format(d) : "–");
  const m = detail.message;
  const scheduled = m.status === "queued" && !!m.sendAt && m.sendAt.getTime() > Date.now();

  const fields: [string, string | null][] = [
    ["field_to", m.email],
    ["field_subject", m.subject && hasPermission(actor, "persons.read") ? m.subject : null],
    ["field_template", detail.templateSlug],
    ["field_kind", t(`kind_${m.kind}`)],
    ["field_from_domain", m.fromDomain],
    ["field_locale", m.locale],
    ["field_campaign", detail.campaignName],
    ["field_idempotency_key", m.idempotencyKey],
    ["field_resend_id", m.resendId],
    ["field_error", m.error],
    ["field_queued_at", at(m.queuedAt)],
    ["field_send_at", m.sendAt ? at(m.sendAt) : null],
    ["field_sent_at", m.sentAt ? at(m.sentAt) : null],
    ["field_attempt", String(m.attempt)],
  ];

  return (
    <div className="grid gap-6" data-testid="email-message" data-status={m.status}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t("detail_title")}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={m.status === "bounced" || m.status === "complained" || m.status === "failed" ? "destructive" : "secondary"}>{t(`status_${m.status}`)}</Badge>
            {m.bounceType ? <Badge variant="outline">{t(`bounce_${m.bounceType}`)}</Badge> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {detail.canResend && hasPermission(actor, "persons.write") ? <ResendMessageButton messageId={m.id} labels={labels} /> : null}
          {scheduled && hasPermission(actor, "email.send") ? <CancelScheduledButton messageId={m.id} labels={labels} /> : null}
          {m.personId && hasPermission(actor, "persons.read") ? (
            <Button variant="outline" asChild>
              <Link href={`/admin/persons/${m.personId}`}>{t("open_person")}</Link>
            </Button>
          ) : null}
          <Button variant="ghost" asChild>
            <Link href="/admin/email/messages">{t("back")}</Link>
          </Button>
        </div>
      </div>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{t("headers")}</h2>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
          {fields
            .filter(([, v]) => v !== null && v !== "")
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{t(k)}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
        </dl>
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{t("events_title")}</h2>
        {detail.events.length ? (
          <Table data-testid="message-events">
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_time")}</TableHead>
                <TableHead>{t("col_event")}</TableHead>
                <TableHead>{t("col_source")}</TableHead>
                <TableHead>{t("col_detail")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.events.map((e) => (
                <TableRow key={e.id} data-event={e.type}>
                  <TableCell>{at(e.occurredAt)}</TableCell>
                  <TableCell>{t(`event_${e.type}`)}</TableCell>
                  <TableCell>{e.source}</TableCell>
                  <TableCell className="max-w-[28rem] truncate">{e.url ?? e.reason ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{t("events_empty")}</p>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{t("rendered_title")}</h2>
        {detail.html ? (
          <iframe title={t("rendered_title")} srcDoc={detail.html} sandbox="" className="h-[640px] w-full max-w-[680px] rounded-md border bg-white" />
        ) : (
          <p className="text-sm text-muted-foreground">{t("rendered_unavailable")}</p>
        )}
      </section>
    </div>
  );
}

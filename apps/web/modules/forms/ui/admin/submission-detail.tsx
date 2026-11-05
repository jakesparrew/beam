"use client";

/**
 * The submission detail (forms spec section 5 `/admin/forms/[formId]/submissions/[submissionId]`;
 * forms-P6): answers per section as the visitor saw them (labels of the pinned version, staff
 * locale), hidden and UTM values, score per dimension with range, outcome, ending, path, consent
 * snapshot, attribution, the form timeline, result email status and result link, and the locked
 * sensitive card. Actions: resend the result email (`forms.write`, 3 times), revoke the result
 * link (`forms.write`), delete the submission with a reason (`forms.publish`).
 */
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import Link from "next/link";
import { formatDate, formatDateTime, formatNumber, type Locale } from "@beam/core/i18n";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, toast } from "@beam/ui";
import { deleteSubmission, resendResultEmail, revokeResultLink } from "../../actions";
import type { SubmissionDetail as Detail } from "../../queries";
import { selectClass } from "./condition-builder";
import { lbl, type Labels } from "./issues-panel";
import { SensitiveCard } from "./sensitive-card";

export type SubmissionDetailProps = {
  detail: Detail;
  locale: Locale;
  labels: Labels;
  can: { write: boolean; publish: boolean; reveal: boolean };
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">{children}</CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[14rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

const REASONS = ["spam", "test", "subject_request"] as const;

function DeletePanel({ submissionId, formId, labels }: { submissionId: string; formId: string; labels: Labels }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("spam");
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        {lbl(labels, "submissions.delete")}
      </Button>
    );
  }
  return (
    <div role="group" aria-labelledby="delete-title" className="grid w-full gap-3 rounded-md border border-destructive p-3">
      <p id="delete-title" className="font-medium">
        {lbl(labels, "submissions.delete_title")}
      </p>
      <p className="text-sm text-muted-foreground">{lbl(labels, "submissions.delete_body")}</p>
      <label className="grid gap-1 text-sm">
        {lbl(labels, "submissions.delete_reason")}
        <select className={selectClass} value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {lbl(labels, `submissions.reason_${r}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              const r = await deleteSubmission({ submissionId, reason });
              setBusy(false);
              if (!r.ok) {
                toast.error(lbl(labels, `builder.error.${r.error.code}`));
                return;
              }
              toast.success(lbl(labels, "submissions.deleted"));
              router.push(`/admin/forms/${formId}/submissions` as Route);
            })()
          }
        >
          {lbl(labels, "submissions.delete_confirm")}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          {lbl(labels, "submissions.cancel")}
        </Button>
      </div>
    </div>
  );
}

export function SubmissionDetail({ detail: d, locale, labels, can }: SubmissionDetailProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>, done: string) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      const key = r.error?.message === "resend_limit" ? "submissions.resend_limit" : `builder.error.${r.error?.code ?? "internal"}`;
      toast.error(lbl(labels, key));
      return;
    }
    toast.success(lbl(labels, done));
    router.refresh();
  };
  const L = (key: string, params?: Record<string, string | number>) => lbl(labels, `submissions.${key}`, params);
  const plainAnswers = d.sections.flatMap((s) => s.answers);
  const answered = plainAnswers.some((a) => a.value !== null);
  const utm = Object.entries(d.attribution.utm).filter(([, v]) => v);

  return (
    <div className="grid gap-6">
      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Row label={L("person")}>
          {!d.person ? (
            L("anonymous")
          ) : d.person.erased ? (
            L("erased")
          ) : (
            <Link className="underline" href={`/admin/persons/${d.person.id}` as Route}>
              {d.person.name ?? d.person.email ?? d.person.id}
            </Link>
          )}
        </Row>
        <Row label={L("status")}>
          <Badge variant={d.status === "completed" ? "default" : "secondary"}>{L(`status_${d.status}`)}</Badge>
        </Row>
        <Row label={L("version")}>{L("version_n", { n: d.version.version })}</Row>
        <Row label={L("locale")}>{d.locale}</Row>
        <Row label={L("started_at")}>{formatDateTime(d.startedAt, locale)}</Row>
        <Row label={L("completed_at")}>{d.completedAt ? formatDateTime(d.completedAt, locale) : "—"}</Row>
      </dl>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <Section title={L("answers")}>
            {!answered ? <p className="text-muted-foreground">{L("no_answers")}</p> : null}
            {d.sections.map((s) => (
              <section key={s.key} className="grid gap-2" aria-label={s.title ?? s.key} data-visited={s.visited}>
                <h3 className="pt-2 font-medium">{s.title ?? s.key}</h3>
                <dl className="grid gap-2">
                  {s.answers.map((a) => (
                    <Row key={a.key} label={a.label}>
                      {a.sensitive ? <span className="text-muted-foreground">{L("sensitive_title")}</span> : (a.value ?? <span className="text-muted-foreground">{L("not_answered")}</span>)}
                    </Row>
                  ))}
                </dl>
              </section>
            ))}
          </Section>

          {d.hiddenValues.length || utm.length ? (
            <Section title={L("hidden_values")}>
              <dl className="grid gap-2">
                {d.hiddenValues.map((a) => (
                  <Row key={a.key} label={a.label}>
                    {a.value ?? "—"}
                  </Row>
                ))}
                {utm.map(([k, v]) => (
                  <Row key={`utm_${k}`} label={`utm_${k}`}>
                    {v}
                  </Row>
                ))}
              </dl>
            </Section>
          ) : null}

          {d.hasSensitive ? <SensitiveCard submissionId={d.id} count={d.sensitiveCount} canReveal={can.reveal} anonymous={!d.person} labels={labels} /> : null}

          <Section title={L("score")}>
            {!d.scored ? (
              <p className="text-muted-foreground">{L("not_scored")}</p>
            ) : (
              <dl className="grid gap-2">
                <Row label={L("total")}>
                  {d.total !== null ? formatNumber(d.total, locale) : "—"}
                  {d.totalRangeLabel ? ` (${d.totalRangeLabel})` : ""}
                </Row>
                {d.dimensions.map((x) => (
                  <Row key={x.key} label={x.label}>
                    {x.sensitive ? (
                      <span className="text-muted-foreground">{L("sensitive_title")}</span>
                    ) : (
                      <>
                        {x.value !== null ? formatNumber(x.value, locale) : "—"}
                        {x.rangeLabel ? ` (${x.rangeLabel})` : ""}
                      </>
                    )}
                  </Row>
                ))}
              </dl>
            )}
            <dl className="grid gap-2 pt-2">
              <Row label={L("outcome")}>{d.outcome?.label ?? L("no_outcome")}</Row>
              <Row label={L("ending")}>{d.ending ? (d.ending.title ?? d.ending.key) : "—"}</Row>
              <Row label={L("path")}>{d.path.length ? d.path.map((p) => p.title ?? p.key).join(" → ") : "—"}</Row>
            </dl>
          </Section>
        </div>

        <div className="grid content-start gap-6">
          <Section title={L("result_email")}>
            {d.resultEmail ? <p>{L("result_email_status", { status: L(`email_status_${d.resultEmail.status}`) })}</p> : <p className="text-muted-foreground">{L("result_email_none")}</p>}
            {d.resendCount ? <p className="text-muted-foreground">{L("resends_used", { n: d.resendCount })}</p> : null}
            <p>
              {L("result_link")}:{" "}
              {!d.resultLink ? L("result_link_none") : d.resultLink.expired ? L("result_link_expired") : d.resultLink.expiresAt ? L("result_link_valid", { date: formatDate(d.resultLink.expiresAt, locale) }) : "—"}
            </p>
            {can.write && d.status === "completed" ? (
              <div className="flex flex-wrap gap-2 pt-2">
                {d.person && !d.person.erased ? (
                  <Button type="button" variant="outline" disabled={busy || d.resendCount >= 3} onClick={() => void run(() => resendResultEmail({ submissionId: d.id }), "submissions.resend_done")}>
                    {L("resend")}
                  </Button>
                ) : null}
                {d.resultLink ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(L("revoke_confirm"))) void run(() => revokeResultLink({ submissionId: d.id }), "submissions.revoke_done");
                    }}
                  >
                    {L("revoke")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </Section>

          <Section title={L("consents")}>
            {d.consents.length ? (
              <ul className="grid gap-1">
                {d.consents.map((c) => {
                  const extra = c as { pendingConfirmation?: boolean; skippedMinor?: boolean };
                  const state = extra.pendingConfirmation ? "consent_pending" : extra.skippedMinor ? "consent_minor" : c.granted ? "consent_granted" : "consent_not_granted";
                  return (
                    <li key={`${c.purpose}:${c.fieldKey}`} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.purpose}</span>
                      <Badge variant={c.granted ? "success" : "outline"}>{L(state)}</Badge>
                      <span className="text-xs text-muted-foreground">{c.wordingVersion}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-muted-foreground">{L("no_consents")}</p>
            )}
          </Section>

          <Section title={L("attribution")}>
            <dl className="grid gap-2">
              <Row label={L("source")}>{d.attribution.source}</Row>
              <Row label={L("campaign")}>{d.attribution.campaign ?? "—"}</Row>
              <Row label={L("funnel")}>{d.attribution.funnel}</Row>
              <Row label={L("link")}>{d.attribution.linkName ?? "—"}</Row>
              <Row label={L("landing_path")}>{d.attribution.landingPath ?? "—"}</Row>
              <Row label={L("referrer")}>{d.attribution.referrerUrl ?? "—"}</Row>
              <Row label={L("embed_host")}>{d.attribution.embedHost ?? "—"}</Row>
              {d.attribution.enteredByName ? <Row label={L("entered_by")}>{d.attribution.enteredByName}</Row> : null}
            </dl>
          </Section>

          <Section title={L("timeline")}>
            {d.events.length ? (
              <ol className="grid gap-1">
                {d.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap justify-between gap-2">
                    <code className="text-xs">{e.kind}</code>
                    <span className="text-muted-foreground">{formatDateTime(e.occurredAt, locale, "short")}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted-foreground">{L("no_events")}</p>
            )}
          </Section>

          {can.publish ? (
            <div className="flex">
              <DeletePanel submissionId={d.id} formId={d.formId} labels={labels} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

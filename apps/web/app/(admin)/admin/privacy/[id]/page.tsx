import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Input, Label, buttonVariants } from "@beam/ui";
import { ERASE_EXTERNAL_PROVIDERS, ERASE_ORDER } from "@beam/core/ops";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { cancelPrivacyRequest, completeRectification, liftRestriction, runPrivacyRequestNow, verifyPrivacyRequest } from "@/modules/ops/privacy/actions";
import { getPrivacyRequest } from "@/modules/ops/privacy/queries";

/**
 * `/admin/privacy/[id]` (`privacy.run`, ops spec 5, rules 59a-64): the request with its warnings,
 * schedule, step-by-step progress (external systems, then each module in `ERASE_ORDER`, then the
 * report), the report itself (module, table, rows, action; never personal data), external
 * outcomes, the retained tables with their legal basis and, for a finished export, the download.
 * Actions: verify (note, acknowledged warnings), run now, cancel, complete a rectification, lift
 * a restriction.
 */
const ERROR_KEYS = new Set(["forbidden", "validation", "not_found", "conflict", "rate_limited"]);

function backTo(id: string, result: { ok: boolean; error?: { code: string } }): never {
  redirect((result.ok ? `/admin/privacy/${id}?ok=1` : `/admin/privacy/${id}?error=${result.error?.code ?? "validation"}`) as never);
}

function str(fd: FormData, k: string): string {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
}

export default async function PrivacyRequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const actor = await requireStaff({ permission: "privacy.run" });
  const { id } = await params;
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const r = await getPrivacyRequest(db, id);
  if (!r) notFound();
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" });
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Brussels" });
  const here = `/admin/privacy/${r.id}`;

  async function verify(fd: FormData) {
    "use server";
    backTo(id, await verifyPrivacyRequest({ requestId: id, verificationNote: str(fd, "verificationNote"), acknowledgeWarnings: fd.get("acknowledgeWarnings") === "on" }));
  }
  async function runNow() {
    "use server";
    backTo(id, await runPrivacyRequestNow({ requestId: id }));
  }
  async function cancel(fd: FormData) {
    "use server";
    backTo(id, await cancelPrivacyRequest({ requestId: id, reason: str(fd, "reason") }));
  }
  async function complete() {
    "use server";
    backTo(id, await completeRectification({ requestId: id }));
  }
  async function lift(fd: FormData) {
    "use server";
    backTo(id, await liftRestriction({ personId: str(fd, "personId"), reason: str(fd, "reason") }));
  }

  const error = sp.error ? (ERROR_KEYS.has(sp.error) ? sp.error : "validation") : null;
  const modulesDone = new Set(r.report.steps.map((s) => s.module));
  const externalDone = ERASE_EXTERNAL_PROVIDERS.every((p) => r.report.external.some((e) => e.provider === p && e.outcome !== "provider_retains"));
  const canRunNow = (r.kind === "erase" && (r.status === "verified" || r.status === "failed") && hasPermission(actor, "persons.erase")) || (r.kind === "export" && r.status === "failed");

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          {tr(`ops.privacy.kind.${r.kind}`)} · {r.personName ?? r.personId.slice(0, 8)}
        </h1>
        <Link href="/admin/privacy" className={buttonVariants({ variant: "outline", size: "sm" })}>
          {tr("ops.privacy.title")}
        </Link>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{tr(`platform.errors.${error}`)}</AlertDescription>
        </Alert>
      ) : null}

      <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
        <dt className="text-muted-foreground">{tr("platform.jobs.col_status")}</dt>
        <dd className="flex flex-wrap gap-1">
          <Badge variant={r.status === "failed" ? "destructive" : r.status === "done" ? "success" : "secondary"}>{tr(`ops.privacy.status.${r.status}`)}</Badge>
          {r.needsManualFollowup ? <Badge variant="destructive">{tr("ops.privacy.manual_followup")}</Badge> : null}
        </dd>
        <dt className="text-muted-foreground">{tr("platform.users.col_actor")}</dt>
        <dd>{tr(`ops.privacy.requested_by.${r.requestedBy}`)}</dd>
        <dt className="text-muted-foreground">{tr("ops.privacy.due_on", { date: "" }).trim()}</dt>
        <dd>{dateFmt.format(new Date(`${r.dueOn}T12:00:00Z`))}</dd>
        {r.verificationNote ? (
          <>
            <dt className="text-muted-foreground">{tr("ops.privacy.verification_note")}</dt>
            <dd>{r.verificationNote}</dd>
          </>
        ) : null}
        {r.scheduledForAt && r.kind === "erase" ? (
          <>
            <dt className="text-muted-foreground">{tr("ops.privacy.scheduled_for", { date: "" }).trim()}</dt>
            <dd>{tr("ops.privacy.scheduled_for", { date: fmt.format(r.scheduledForAt) })}</dd>
          </>
        ) : null}
        {r.rectifyFields.length ? (
          <>
            <dt className="text-muted-foreground">{tr("ops.privacy.kind.rectify")}</dt>
            <dd>{r.rectifyFields.map((f) => tr(`ops.privacy.rectify_field.${f}`)).join(", ")}</dd>
          </>
        ) : null}
      </dl>

      {r.warnings.length ? (
        <Alert>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {r.warnings.map((w) => (
                <li key={w}>{tr(`ops.privacy.warning.${w}`)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {r.status === "received" ? (
          <form action={verify} className="grid w-full max-w-xl gap-2 rounded-md border p-3">
            <Label htmlFor="verify-note">{tr("ops.privacy.verification_note")}</Label>
            <textarea id="verify-note" name="verificationNote" required maxLength={500} rows={2} className="rounded-md border bg-background p-2 text-sm" />
            {r.kind === "erase" ? (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="acknowledgeWarnings" />
                {tr("ops.privacy.acknowledge_warnings")}
              </label>
            ) : null}
            <Button type="submit" className="w-fit">
              {tr("ops.privacy.verify")}
            </Button>
          </form>
        ) : null}
        {canRunNow ? (
          <form action={runNow}>
            <Button type="submit" variant="destructive">
              {tr("ops.privacy.run_now")}
            </Button>
          </form>
        ) : null}
        {r.kind === "rectify" && r.status === "verified" ? (
          <form action={complete}>
            <Button type="submit">{tr("ops.privacy.complete_rectification")}</Button>
          </form>
        ) : null}
        {r.restricted ? (
          <form action={lift} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="personId" value={r.personId} />
            <Input name="reason" required maxLength={500} aria-label={tr("ops.privacy.lift_restriction")} className="w-64" />
            <Button type="submit" variant="outline">
              {tr("ops.privacy.lift_restriction")}
            </Button>
          </form>
        ) : null}
        {r.status === "received" || r.status === "verified" ? (
          <form action={cancel} className="flex flex-wrap items-end gap-2">
            <Input name="reason" required maxLength={500} aria-label={tr("ops.privacy.cancel")} className="w-64" />
            <Button type="submit" variant="outline">
              {tr("ops.privacy.cancel")}
            </Button>
          </form>
        ) : null}
        {r.kind === "export" && r.status === "done" && r.hasExport ? (
          <a href={`${here}/download`} className={buttonVariants({ variant: "outline" })}>
            {tr("ops.privacy.portal.download")}
          </a>
        ) : null}
      </div>

      {r.kind === "erase" ? (
        <section className="grid gap-3" aria-labelledby="privacy-progress">
          <h2 id="privacy-progress" className="text-lg font-semibold">
            {tr("ops.privacy.step.external")} · {tr("ops.privacy.step.finalise")}
          </h2>
          <ol className="grid gap-1 text-sm">
            <li>
              {externalDone ? "✓" : "○"} {tr("ops.privacy.step.external")}
            </li>
            {ERASE_ORDER.map((m) => (
              <li key={m}>
                {modulesDone.has(m) ? "✓" : "○"} {tr(`ops.privacy.step.module.${m}`)}
              </li>
            ))}
            <li>
              {r.status === "done" ? "✓" : "○"} {tr("ops.privacy.step.finalise")}
            </li>
          </ol>
          {r.report.external.length ? (
            <ul className="grid gap-1 text-sm">
              {r.report.external.map((e) => (
                <li key={e.provider}>
                  <span className="font-mono">{e.provider}</span>: {tr(`ops.privacy.outcome.${e.outcome}`)}
                </li>
              ))}
            </ul>
          ) : null}
          {r.report.steps.length ? (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-3 py-2">{tr("platform.jobs.col_kind")}</th>
                    <th className="px-3 py-2">{tr("platform.security.col_table")}</th>
                    <th className="px-3 py-2">{tr("platform.security.col_rows")}</th>
                    <th className="px-3 py-2">{tr("platform.users.col_action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.report.steps.map((s, i) => (
                    <tr key={`${s.module}:${s.table}:${i}`} className="border-t">
                      <td className="px-3 py-2">{tr(`ops.privacy.step.module.${s.module}`)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.table}</td>
                      <td className="px-3 py-2">{s.rows}</td>
                      <td className="px-3 py-2">{["deleted", "anonymised", "retained_legal", "kept"].includes(s.action) ? tr(`ops.privacy.action.${s.action}`) : s.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {r.report.retained.length ? (
            <ul className="grid gap-1 text-sm">
              {r.report.retained.map((x) => (
                <li key={x.table}>
                  <span className="font-mono">{x.table}</span>: {tr(`ops.privacy.legal_basis.${x.legal_basis}`)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <Link href={`/admin/persons/${r.personId}` as Route} className="underline-offset-4 hover:underline">
          {r.personId}
        </Link>
      </p>
    </div>
  );
}

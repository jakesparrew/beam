import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { emailHash, normaliseEmail } from "@beam/core/crm";
import { formatDateTime } from "@beam/core/i18n";
import { Button, EmptyState, FormField, Input } from "@beam/ui";
import { webinarLandingUrl } from "@beam/email/templates/webinar";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { findPersonIdsByEmailHash } from "@/modules/crm/api";
import { cancelRegistrationByStaff, exportWebinarRegistrants, moderate, registerPersonByStaff, resendAccessLink, revokeAccessLink } from "@/modules/webinar/actions";
import { getWebinar, listRegistrations, type RegistrantRow } from "@/modules/webinar/queries";
import { textIn } from "@/modules/webinar/server/lifecycle";
import { REGISTRATION_OPS, RegistrationsTable, type RegistrationOp, type RegistrationsTableRow } from "@/modules/webinar/ui/registrations-table";

export const dynamic = "force-dynamic";

/** A text field of a posted form ("" when absent or a file). */
const textField = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["registered", "cancelled", "blocked"] as const;
const SEGMENTS = ["lead", "customer", "member"] as const;
const FILE_ID = /^[0-9a-f-]{36}$/i;
/** The `moderate` action of each moderation op of the table. */
const MODERATION = { mute: "mute_viewer", unmute: "unmute_viewer", block: "block_viewer", unblock: "unblock_viewer" } as const;

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; status?: string; segment?: string; page?: string; done?: string; error?: string; file?: string }> };

/**
 * `/admin/webinars/[id]/registrations` (`webinars.host` + `persons.read`, webinar spec 5.1 and
 * section 7): registrants with name, email, status, the lead/customer/member snapshot, registered
 * mode, source, watch minutes per mode and the last activity; register an existing person (by
 * email, with or without the access email), cancel, resend and revoke a link, mute or unmute and
 * block or unblock a viewer (`moderate`). "Export CSV" (`persons.export` on top) runs
 * `exportWebinarRegistrants` and comes back with the file's download link. Empty state
 * "Nobody registered yet. Share the landing page: <url>."
 */
export default async function WebinarRegistrationsPage({ params, searchParams }: Props) {
  const actor = await requireStaff({ permission: "webinars.host" });
  if (!hasPermission(actor, "persons.read")) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const g = (k: string, p?: Record<string, string | number>) => tr(`webinar.admin.registrations.${k}`, p);
  const db = await getAppDb();
  const detail = await getWebinar(db, id);
  if (!detail) notFound();
  const w = detail.webinar;
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status);
  const segment = SEGMENTS.find((s) => s === sp.segment);
  const page = Math.max(1, Number(sp.page) || 1);
  const list = await listRegistrations(db, w.id, { ...(status ? { status } : {}), ...(segment ? { personStatus: segment } : {}), ...(sp.q ? { q: sp.q } : {}), page });
  const here = `/admin/webinars/${w.id}/registrations`;

  async function act(formData: FormData) {
    "use server";
    const posted = textField(formData, "op");
    const op = REGISTRATION_OPS.find((o): o is RegistrationOp => o === posted);
    const registrationId = textField(formData, "registrationId");
    if (!op) redirect(`${here}?error=internal` as Route);
    const res =
      op === "cancel"
        ? await cancelRegistrationByStaff({ registrationId })
        : op === "resend"
          ? await resendAccessLink({ registrationId })
          : op === "revoke"
            ? await revokeAccessLink({ registrationId })
            : await moderate({ webinarId: w.id, action: MODERATION[op], registrationId });
    redirect((res.ok ? `${here}?done=1` : `${here}?error=${encodeURIComponent(res.error.code)}`) as Route);
  }

  async function register(formData: FormData) {
    "use server";
    const email = normaliseEmail(textField(formData, "email"));
    const ids = email ? await findPersonIdsByEmailHash(await getAppDb(), emailHash(email)) : [];
    if (!ids[0]) redirect(`${here}?error=person_not_found` as Route);
    const res = await registerPersonByStaff({ webinarId: w.id, personId: ids[0], sendAccessEmail: formData.get("sendAccessEmail") === "on" });
    const reason = res.ok ? null : res.error.message === "webinar.register.closed" ? "closed" : res.error.message === "webinar.access.blocked" ? "blocked" : res.error.code;
    redirect((reason ? `${here}?error=${encodeURIComponent(reason)}` : `${here}?done=1`) as Route);
  }

  async function exportCsv() {
    "use server";
    const res = await exportWebinarRegistrants({ webinarId: w.id });
    redirect((res.ok ? `${here}?file=${res.data.fileId}` : `${here}?error=${encodeURIComponent(res.error.code)}`) as Route);
  }

  const canExport = hasPermission(actor, "persons.export");
  const fileId = sp.file && FILE_ID.test(sp.file) ? sp.file : null;
  const errorText = sp.error
    ? sp.error === "person_not_found"
      ? g("register_not_found")
      : (["forbidden", "conflict", "not_found", "closed", "blocked"].includes(sp.error) ? g(`errors.${sp.error}`) : g("errors.internal"))
    : null;
  const minutes = (sec: number) => Math.round(sec / 60);
  const nameOf = (r: RegistrantRow) => [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || r.personId.slice(0, 8);
  const rows: RegistrationsTableRow[] = list.rows.map((r) => ({
    id: r.id,
    name: nameOf(r),
    email: r.email,
    status: r.status,
    personStatus: r.personStatus,
    registeredMode: r.registeredMode,
    source: r.source,
    muted: r.mutedAt !== null,
    watchedMinutes: { live: minutes(r.watchedSec.live), replay: minutes(r.watchedSec.replay), on_demand: minutes(r.watchedSec.on_demand) },
    lastActivity: r.lastActivityAt ? formatDateTime(r.lastActivityAt, locale, "short") : "",
    personHref: `/admin/persons/${r.personId}`,
  }));
  const filtersActive = Boolean(status || segment || sp.q);

  return (
    <div className="grid gap-6">
      <Link href={`/admin/webinars/${w.id}` as Route} className="text-sm underline">
        {textIn(w.title, locale) || w.slug}
      </Link>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{g("title")}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">{g("count", { count: list.total })}</p>
          {canExport ? (
            <form action={exportCsv} data-testid="webinar-registrants-export">
              <Button type="submit" variant="outline" size="sm">
                {g("export")}
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      <div aria-live="polite">
        {sp.done ? (
          <p role="status" className="rounded-md border border-border p-3 text-sm">
            {g("done")}
          </p>
        ) : null}
        {fileId ? (
          <p role="status" className="rounded-md border border-border p-3 text-sm">
            {g("export_ready")}{" "}
            <a href={`/api/public/files/${fileId}`} className="underline" download>
              {g("export_download")}
            </a>
          </p>
        ) : null}
        {errorText ? <p className="rounded-md border border-destructive p-3 text-sm">{errorText}</p> : null}
      </div>

      <section aria-labelledby="register-person" className="space-y-3 rounded-lg border border-border p-4">
        <h2 id="register-person" className="text-lg font-semibold">
          {g("register_title")}
        </h2>
        <form action={register} className="flex flex-wrap items-end gap-3">
          <FormField label={g("register_email")} required>
            <Input name="email" type="email" required maxLength={254} className="w-72" />
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="sendAccessEmail" defaultChecked className="size-4" />
            {g("register_send")}
          </label>
          <Button type="submit">{g("register_submit")}</Button>
        </form>
      </section>

      <form method="get" className="flex flex-wrap items-end gap-3" role="search">
        <FormField label={g("search")}>
          <Input name="q" defaultValue={sp.q ?? ""} className="w-64" />
        </FormField>
        <label className="grid gap-1 text-sm">
          {g("filter_status")}
          <select name="status" defaultValue={status ?? ""} className="h-9 rounded-md border border-input bg-background px-2">
            <option value="">{g("all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {g(`status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {g("filter_segment")}
          <select name="segment" defaultValue={segment ?? ""} className="h-9 rounded-md border border-input bg-background px-2">
            <option value="">{g("all")}</option>
            {SEGMENTS.map((s) => (
              <option key={s} value={s}>
                {g(`segment.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline">
          {g("apply")}
        </Button>
      </form>

      {rows.length === 0 && !filtersActive ? (
        <EmptyState title={g("empty", { url: webinarLandingUrl(w.slug, w.spokenLocale) })} />
      ) : (
        <RegistrationsTable
          rows={rows}
          action={act}
          canAct={w.status !== "archived"}
          labels={{
            caption: g("title"),
            name: g("col_name"),
            email: g("col_email"),
            status: g("col_status"),
            segment: g("col_segment"),
            registeredMode: g("col_registered_mode"),
            source: g("col_source"),
            watch: g("col_watch"),
            lastActivity: g("col_last_activity"),
            actions: g("col_actions"),
            minutes: (n) => g("minutes", { minutes: n }),
            muted: g("muted"),
            statuses: { registered: g("status.registered"), cancelled: g("status.cancelled"), blocked: g("status.blocked") },
            segments: { lead: g("segment.lead"), customer: g("segment.customer"), member: g("segment.member") },
            sources: { site: g("source.site"), portal: g("source.portal"), admin: g("source.admin"), automation: g("source.automation") },
            modes: { live: tr("webinar.enum.watch_mode.live"), replay: tr("webinar.enum.watch_mode.replay"), on_demand: tr("webinar.enum.watch_mode.on_demand") },
            cancel: g("cancel"),
            resend: g("resend"),
            revoke: g("revoke"),
            revokeHint: g("revoke_confirm"),
            mute: g("mute"),
            unmute: g("unmute"),
            block: g("block"),
            unblock: g("unblock"),
            blockHint: g("block_hint"),
          }}
        />
      )}
      {list.hasMore ? (
        <Link href={`${here}?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(status ? { status } : {}), ...(segment ? { segment } : {}), page: String(page + 1) })}` as Route} className="text-sm underline">
          {g("more")}
        </Link>
      ) : null}
    </div>
  );
}

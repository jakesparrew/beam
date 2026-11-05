/**
 * `/admin/forms/imports/[sourceId]` (`forms.publish`; forms spec section 5, rules I1 to I5): the
 * webhook URL with the secret masked, the mapping, and the events table (received, status,
 * reason, submission link) with a status filter and cursor paging; rotate the secret, upload a
 * CSV backfill and reprocess failed or skipped events. Payloads are never shown.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getImportSource, IMPORT_EVENT_STATUSES, listImportEvents, screenLabels, type ImportEventStatus } from "@/modules/forms/queries";
import { ImportEventsTable, ImportSourceActions } from "@/modules/forms/ui/admin/import-events-table";
import { ImportSourceToggle } from "@/modules/forms/ui/admin/import-wizard";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function ImportSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ sourceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaff({ permission: "forms.publish" });
  const { sourceId } = await params;
  if (!UUID.test(sourceId)) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = screenLabels(locale, ["imports"]);
  const db = await getAppDb();
  const source = await getImportSource(db, sourceId);
  if (!source) notFound();
  const rawStatus = one(sp.status);
  const status = (IMPORT_EVENT_STATUSES as readonly string[]).includes(rawStatus ?? "") ? (rawStatus as ImportEventStatus) : undefined;
  const cursor = one(sp.cursor);
  const page = await listImportEvents(db, { sourceId, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) });
  const times = Object.fromEntries(page.rows.map((r) => [r.id, { receivedAt: formatDateTime(r.receivedAt, locale), processedAt: r.processedAt ? formatDateTime(r.processedAt, locale) : null }]));
  const m = source.mapping;
  const sensitiveLabel = tr("forms.imports.wizard.field_sensitive");
  const mappingRows: [string, string][] = m
    ? [
        ["email", m.email],
        ["externalId", m.externalId],
        ...(["firstName", "lastName", "phone", "locale", "completedAt", "score", "outcome"] as const).flatMap((k): [string, string][] => (m[k] ? [[k, m[k]]] : [])),
        ...Object.entries(m.answers).map(([k, p]): [string, string] => [`answers.${k}${m.sensitiveFieldKeys.includes(k) ? ` · ${sensitiveLabel}` : ""}`, p]),
        ...Object.entries(m.consents ?? {}).map(([k, p]): [string, string] => [`consents.${k}`, p ?? ""]),
      ]
    : [];
  const statusHref = (s?: ImportEventStatus) => `/admin/forms/imports/${source.id}${s ? `?status=${s}` : ""}` as `/admin/forms/imports/${string}`;
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            {source.name}
            <Badge variant={source.isActive ? "success" : "outline"}>{tr(source.isActive ? "forms.imports.active" : "forms.imports.inactive")}</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            {tr(`forms.imports.provider_${source.provider}`)} ·{" "}
            <Link className="underline" href={`/admin/forms/${source.formId}`}>
              {source.formSlug}
            </Link>{" "}
            · {tr("forms.imports.counts", { ...source.counts })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ImportSourceToggle sourceId={source.id} isActive={source.isActive} labels={labels} />
          <Link className="text-sm underline" href="/admin/forms/imports">
            {tr("forms.imports.back")}
          </Link>
        </div>
      </header>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{tr("forms.imports.webhook_url")}</h2>
        <code className="break-all rounded bg-muted p-2 text-sm">{source.maskedUrl}</code>
        <p className="text-xs text-muted-foreground">{tr("forms.imports.secret_help")}</p>
        <ImportSourceActions sourceId={source.id} labels={labels} />
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{tr("forms.imports.mapping")}</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("forms.imports.mapping_field")}</TableHead>
              <TableHead>{tr("forms.imports.mapping_path")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mappingRows.map(([k, p]) => (
              <TableRow key={k}>
                <TableCell className="text-sm">{k}</TableCell>
                <TableCell>
                  <code className="text-xs">{p}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{tr("forms.imports.events")}</h2>
          <nav aria-label={tr("forms.imports.filter")} className="flex flex-wrap gap-3 text-sm">
            <Link className={status ? "underline" : "font-semibold"} href={statusHref()}>
              {tr("forms.imports.filter_all")}
            </Link>
            {IMPORT_EVENT_STATUSES.map((s) => (
              <Link key={s} className={status === s ? "font-semibold" : "underline"} href={statusHref(s)}>
                {tr(`forms.imports.status_${s}`)}
              </Link>
            ))}
          </nav>
        </div>
        <ImportEventsTable formId={source.formId} rows={page.rows} labels={labels} times={times} />
        {page.nextCursor ? (
          <Link
            className="text-sm underline"
            href={`/admin/forms/imports/${source.id}?${new URLSearchParams({ ...(status ? { status } : {}), cursor: page.nextCursor }).toString()}` as `/admin/forms/imports/${string}`}
          >
            {tr("forms.imports.next_page")}
          </Link>
        ) : null}
      </section>
    </div>
  );
}

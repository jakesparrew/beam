import type { Route } from "next";
import Link from "next/link";
import { EmptyState } from "@beam/ui";
import { ACQUISITION_SOURCES, PERSON_STATUSES, type AcquisitionSource, type PersonStatus } from "@beam/core/crm";
import { formatNumber, isLocale, type Locale } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, messageTemplate, translator } from "@/lib/i18n";
import { getPersonListFacts, getPersonListKpis, listPersons, listSegments, listTags } from "@/modules/crm/queries";
import { PersonsTable } from "@/modules/crm/ui/person-search";
import { localeOptions, sourceOptions } from "@/modules/crm/ui/status-badge";
import { MoreMenu, PageHeader, PrimaryAction, SecondaryAction } from "@/modules/platform/ui/admin-kit";
import { Field, fieldClass, KpiStrip, ListToolbar, listToolbarLabels, type AppliedFilter } from "@/modules/platform/ui/admin-list-kit";

type Search = { q?: string; view?: string; status?: string; tag?: string; segment?: string; locale?: string; source?: string; tester?: string; corporate?: string; page?: string; sort?: string };

const PAGE_SIZE = 50;
const SORTS = ["created_at", "last_name", "last_activity_at"] as const;
/** The segmented views: everyone, members, with a usable package, created in the last 30 days, corporate clients. */
const VIEWS = ["members", "package", "new", "corporate"] as const;
/** The views shown as toolbar chips; corporate clients sit in Filters. */
const CHIP_VIEWS = ["members", "package", "new"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEW_DAYS = 30;

const pick = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => ((list as readonly string[]).includes(v ?? "") ? (v as T) : undefined);

/**
 * `/admin/persons` (`persons.read`; create and bulk tag `persons.write`), crm spec 5.1, in the
 * back-office kit (owner review, November 2026): the header with "New person", the four key
 * figures (each opens its view), the list toolbar (the super search on name, email, phone or
 * customer number; the views Alle / Leden / Met pakket / Nieuw as chips with their counts;
 * corporate, status, tag, segment, language, source and testers behind "Filters", applied ones as
 * removable chips), then the table whose rows open the 360. Tags and duplicates sit in "⋯".
 */
export default async function PersonsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const l = (k: string, p?: Record<string, string | number>) => tr(`crm.persons.list.${k}`, p);
  const db = await getAppDb();
  const canWrite = hasPermission(actor, "persons.write");

  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const view = pick(VIEWS, sp.view);
  const status = pick<PersonStatus>(PERSON_STATUSES, sp.status);
  const source = pick<AcquisitionSource>(ACQUISITION_SOURCES, sp.source);
  const personLocale: Locale | undefined = isLocale(sp.locale) ? sp.locale : undefined;
  const sort = pick(SORTS, sp.sort) ?? "created_at";
  const tag = sp.tag && UUID.test(sp.tag) ? sp.tag : undefined;
  const segment = sp.segment && UUID.test(sp.segment) ? sp.segment : undefined;
  const tester = sp.tester === "yes" || sp.tester === "no" ? sp.tester : undefined;
  const corporate = view === "corporate" ? "yes" : sp.corporate === "yes" || sp.corporate === "no" ? sp.corporate : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const since = new Date(Date.now() - NEW_DAYS * 86_400_000);

  const [tags, segments, kpis, { rows, total }] = await Promise.all([
    listTags(db),
    listSegments(db, { includeArchived: false }).catch(() => []),
    getPersonListKpis(db, since),
    listPersons(db, {
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      ...(tag ? { tagIds: [tag] } : {}),
      ...(segment ? { segmentId: segment } : {}),
      ...(personLocale ? { locale: personLocale } : {}),
      ...(source ? { source } : {}),
      ...(tester ? { isTester: tester === "yes" } : {}),
      ...(corporate ? { isCorporate: corporate === "yes" } : {}),
      ...(view === "members" ? { isMember: true } : {}),
      ...(view === "package" ? { hasPackage: true } : {}),
      ...(view === "new" ? { createdSince: since } : {}),
      page,
      pageSize: PAGE_SIZE,
      sort,
    }),
  ]);
  const facts = await getPersonListFacts(
    db,
    rows.map((r) => r.id),
  );

  const current: Record<string, string | undefined> = { q, view, status, tag, segment, locale: personLocale, source, tester, corporate: view === "corporate" ? undefined : corporate, sort: sp.sort ? sort : undefined };
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/persons?${s}` : "/admin/persons";
  };
  // `view=corporate` (older links) is the corporate filter of the Filters panel, not a chip.
  const moreFilters = [corporate, status, tag, segment, personLocale, source, tester].filter(Boolean).length;
  const chipCount: Record<(typeof CHIP_VIEWS)[number], number> = { members: kpis.members, package: kpis.withPackage, new: kpis.newSince };
  const yesNo = [
    { value: "yes", label: tr("crm.common.yes") },
    { value: "no", label: tr("crm.common.no") },
  ];
  const yn = (v: string) => tr(v === "yes" ? "crm.common.yes" : "crm.common.no");
  const tagLabel = (t: { key: string; name: Record<string, string | undefined> }) => t.name[locale] ?? t.key;
  const tagRow = tag ? tags.find((t) => t.id === tag) : undefined;
  const applied: AppliedFilter[] = [
    ...(corporate ? [{ key: "corporate", label: l("view_corporate"), value: yn(corporate), href: href({ corporate: undefined, view: view === "corporate" ? undefined : view, page: undefined }) }] : []),
    ...(status ? [{ key: "status", label: l("filter_status"), value: tr(`crm.enums.person_status.${status}`), href: href({ status: undefined, page: undefined }) }] : []),
    ...(tag ? [{ key: "tag", label: l("filter_tag"), value: tagRow ? tagLabel(tagRow) : "—", href: href({ tag: undefined, page: undefined }) }] : []),
    ...(segment ? [{ key: "segment", label: l("filter_segment"), value: segments.find((s) => s.id === segment)?.name ?? "—", href: href({ segment: undefined, page: undefined }) }] : []),
    ...(personLocale ? [{ key: "locale", label: l("filter_locale"), value: localeOptions(tr).find((o) => o.value === personLocale)?.label ?? personLocale, href: href({ locale: undefined, page: undefined }) }] : []),
    ...(source ? [{ key: "source", label: l("filter_source"), value: sourceOptions(tr, ACQUISITION_SOURCES).find((o) => o.value === source)?.label ?? source, href: href({ source: undefined, page: undefined }) }] : []),
    ...(tester ? [{ key: "tester", label: l("filter_tester"), value: yn(tester), href: href({ tester: undefined, page: undefined }) }] : []),
  ];
  const filtered = !!(q || view || moreFilters || corporate);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedTemplate = messageTemplate(locale, "crm.persons.list.selected");
  const n = (v: number) => formatNumber(v, locale);
  const viewLabel: Record<(typeof VIEWS)[number], string> = { members: l("view_members"), package: l("view_package"), new: l("view_new"), corporate: l("view_corporate") };

  const select = (name: string, label: string, value: string | undefined, options: { value: string; label: string }[]) => (
    <Field label={label}>
      <select name={name} defaultValue={value ?? ""} className={fieldClass}>
        <option value="">{tr("crm.common.all")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div className="grid gap-4">
      <PageHeader
        title={l("title")}
        actions={
          <>
            <MoreMenu
              label={tr("platform.table.more_actions")}
              items={[
                { key: "tags", href: "/admin/persons/tags", label: tr("crm.tags.title") },
                ...(hasPermission(actor, "persons.merge") ? [{ key: "duplicates", href: "/admin/persons/duplicates" as Route, label: tr("crm.duplicates.title") }] : []),
              ]}
            />
            {canWrite ? <PrimaryAction href="/admin/persons/new">+ {l("create")}</PrimaryAction> : null}
          </>
        }
      />

      <KpiStrip
        data-testid="persons-kpis"
        items={[
          { key: "total", label: l("kpi_total"), value: n(kpis.total), href: href({ view: undefined, page: undefined }) },
          { key: "members", label: l("kpi_members"), value: n(kpis.members), href: href({ view: "members", page: undefined }) },
          { key: "package", label: l("kpi_package"), value: n(kpis.withPackage), href: href({ view: "package", page: undefined }) },
          { key: "new", label: l("kpi_new", { days: NEW_DAYS }), value: n(kpis.newSince), href: href({ view: "new", page: undefined }) },
        ]}
      />

      <ListToolbar
        labels={listToolbarLabels(tr)}
        search={{ placeholder: l("search_placeholder"), defaultValue: q, label: tr("crm.common.search") }}
        hidden={{ view: view === "corporate" ? undefined : view, sort: sp.sort ? sort : undefined }}
        filters={{
          count: moreFilters,
          children: (
            <>
              {select("corporate", l("view_corporate"), corporate, yesNo)}
              {select("status", l("filter_status"), status, PERSON_STATUSES.map((s) => ({ value: s, label: tr(`crm.enums.person_status.${s}`) })))}
              {select("tag", l("filter_tag"), tag, tags.map((t) => ({ value: t.id, label: tagLabel(t) })))}
              {segments.length ? select("segment", l("filter_segment"), segment, segments.map((s) => ({ value: s.id, label: s.name }))) : null}
              {select("locale", l("filter_locale"), personLocale, localeOptions(tr))}
              {select("source", l("filter_source"), source, sourceOptions(tr, ACQUISITION_SOURCES))}
              {select("tester", l("filter_tester"), tester, yesNo)}
            </>
          ),
        }}
        chips={{
          label: l("views"),
          items: [
            { key: "all", label: tr("crm.common.all"), href: href({ view: undefined, page: undefined }), active: !view || view === "corporate", count: kpis.total },
            ...CHIP_VIEWS.map((v) => ({ key: v, label: viewLabel[v], href: href({ view: v, page: undefined }), active: view === v, count: chipCount[v] })),
          ],
        }}
        applied={applied}
        clearAll={href({ view: view === "corporate" ? undefined : view, corporate: undefined, status: undefined, tag: undefined, segment: undefined, locale: undefined, source: undefined, tester: undefined, page: undefined })}
      />

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState title={l("empty_filtered")} />
        ) : (
          <EmptyState
            title={l("empty")}
            action={
              <span className="flex gap-4">
                <Link href="/admin/persons/new">{l("empty_create")}</Link>
                <Link href={"/admin/imports"}>{l("empty_import")}</Link>
              </span>
            }
          />
        )
      ) : (
        <PersonsTable
          rows={rows.map((r) => {
            const f = facts.get(r.id);
            return {
              id: r.id,
              customerNumber: r.customerNumber,
              name: r.name,
              email: r.email,
              phone: f?.phone ?? null,
              status: r.status,
              isOverridden: r.isOverridden,
              isCorporate: r.isCorporate,
              tags: r.tags,
              dayCredits: f?.dayCredits ?? 0,
              nightCredits: f?.nightCredits ?? 0,
              lastVisitAt: f?.lastVisitAt?.toISOString() ?? null,
              nextBookingAt: f?.nextBookingAt?.toISOString() ?? null,
            };
          })}
          tags={tags.map((t) => ({ id: t.id, key: t.key, label: tagLabel(t), color: t.color }))}
          canWrite={canWrite}
          locale={locale}
          labels={{
            caption: l("caption"),
            corporate: l("corporate"),
            columns: {
              select: tr("crm.common.actions"),
              client: l("col_client"),
              phone: l("col_phone"),
              status: l("col_status"),
              credits: l("col_credits"),
              lastVisit: l("col_last_visit"),
              nextBooking: l("col_next_booking"),
              tags: l("col_tags"),
            },
            statuses: { lead: tr("crm.enums.person_status.lead"), customer: tr("crm.enums.person_status.customer"), member: tr("crm.enums.person_status.member") },
            overridePin: l("override_pin"),
            creditsDay: messageTemplate(locale, "crm.persons.list.credits_day"),
            creditsNight: messageTemplate(locale, "crm.persons.list.credits_night"),
            selectedOne: tr("crm.persons.list.selected", { count: 1 }),
            selectedOther: selectedTemplate.includes("{count") ? tr("crm.persons.list.selected", { count: 7 }) : selectedTemplate,
            selectAll: tr("crm.common.all"),
            picker: {
              tag: l("filter_tag"),
              add: l("bulk_tag"),
              remove: l("bulk_untag"),
              choose: l("filter_tag"),
              changed: tr("crm.common.saved"),
              limit: l("bulk_limit"),
              error: tr("crm.common.error"),
            },
          }}
        />
      )}

      {pages > 1 ? (
        <nav className="flex items-center gap-2 text-[0.8125rem]" aria-label={l("caption")}>
          {page > 1 ? <SecondaryAction href={href({ page: String(page - 1) })}>{tr("crm.common.previous")}</SecondaryAction> : null}
          <span className="text-muted-foreground">{tr("crm.common.page_of", { page, pages })}</span>
          {page < pages ? <SecondaryAction href={href({ page: String(page + 1) })}>{tr("crm.common.next")}</SecondaryAction> : null}
        </nav>
      ) : null}
    </div>
  );
}

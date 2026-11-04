import Link from "next/link";
import { buttonVariants } from "@beam/ui";
import { ACQUISITION_SOURCES, PERSON_STATUSES, type AcquisitionSource, type PersonStatus } from "@beam/core/crm";
import { isLocale, type Locale } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, messageTemplate, translator } from "@/lib/i18n";
import { listPersons, listSegments, listTags } from "@/modules/crm/queries";
import { PersonsTable } from "@/modules/crm/ui/person-search";
import { localeOptions, sourceOptions, statusBadgeLabels } from "@/modules/crm/ui/status-badge";

type Search = { q?: string; status?: string; tag?: string; segment?: string; locale?: string; source?: string; tester?: string; page?: string; sort?: string };

const PAGE_SIZE = 50;
const SORTS = ["created_at", "last_name", "last_activity_at"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/persons` (`persons.read`; bulk tag `persons.write`), crm spec 5.1. */
export default async function PersonsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const canWrite = hasPermission(actor, "persons.write");

  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const status = (PERSON_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as PersonStatus) : undefined;
  const source = (ACQUISITION_SOURCES as readonly string[]).includes(sp.source ?? "") ? (sp.source as AcquisitionSource) : undefined;
  const personLocale: Locale | undefined = isLocale(sp.locale) ? sp.locale : undefined;
  const sort = (SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as (typeof SORTS)[number]) : "created_at";

  const [tags, segments] = await Promise.all([listTags(db), listSegments(db, { includeArchived: false }).catch(() => [])]);
  const { rows, total } = await listPersons(db, {
    ...(sp.q?.trim() ? { q: sp.q.trim() } : {}),
    ...(status ? { status } : {}),
    ...(sp.tag && UUID.test(sp.tag) ? { tagIds: [sp.tag] } : {}),
    ...(sp.segment && UUID.test(sp.segment) ? { segmentId: sp.segment } : {}),
    ...(personLocale ? { locale: personLocale } : {}),
    ...(source ? { source } : {}),
    ...(sp.tester === "yes" ? { isTester: true } : sp.tester === "no" ? { isTester: false } : {}),
    page,
    pageSize: PAGE_SIZE,
    sort,
  });

  const l = (k: string) => tr(`crm.persons.list.${k}`);
  const tagLabel = (t: { key: string; name: Record<string, string | undefined> }) => t.name[locale] ?? t.key;
  const selectedTemplate = messageTemplate(locale, "crm.persons.list.selected");

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{l("title")}</h1>
        <div className="flex gap-2">
          <Link href="/admin/persons/tags" className={buttonVariants({ variant: "outline" })}>
            {tr("crm.tags.title")}
          </Link>
          {canWrite ? (
            <Link href="/admin/persons/new" className={buttonVariants()}>
              {l("create")}
            </Link>
          ) : null}
        </div>
      </header>
      <PersonsTable
        rows={rows.map((r) => ({ ...r, lastActivityAt: r.lastActivityAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }))}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        searchParams={{ q: sp.q, status: sp.status, tag: sp.tag, segment: sp.segment, locale: sp.locale, source: sp.source, tester: sp.tester, sort: sp.sort }}
        options={{
          statuses: PERSON_STATUSES.map((s) => ({ value: s, label: tr(`crm.enums.person_status.${s}`) })),
          tags: tags.map((t) => ({ value: t.id, label: tagLabel(t) })),
          segments: segments.map((s) => ({ value: s.id, label: s.name })),
          locales: localeOptions(tr),
          sources: sourceOptions(tr, ACQUISITION_SOURCES),
        }}
        tags={tags.map((t) => ({ id: t.id, key: t.key, label: tagLabel(t), color: t.color }))}
        canWrite={canWrite}
        locale={locale}
        labels={{
          searchPlaceholder: l("search_placeholder"),
          search: tr("crm.common.search"),
          filterStatus: l("filter_status"),
          filterTag: l("filter_tag"),
          filterSegment: l("filter_segment"),
          filterLocale: l("filter_locale"),
          filterSource: l("filter_source"),
          filterTester: l("filter_tester"),
          all: tr("crm.common.all"),
          yes: tr("crm.common.yes"),
          no: tr("crm.common.no"),
          columns: {
            select: tr("crm.common.actions"),
            number: l("col_number"),
            name: l("col_name"),
            email: l("col_email"),
            status: l("col_status"),
            member: l("col_member"),
            tags: l("col_tags"),
            lastActivity: l("col_last_activity"),
            created: l("col_created"),
          },
          selectedOne: tr("crm.persons.list.selected", { count: 1 }),
          selectedOther: selectedTemplate.includes("{count") ? tr("crm.persons.list.selected", { count: 7 }) : selectedTemplate,
          selectAll: tr("crm.common.all"),
          empty: l("empty"),
          emptyFiltered: tr("crm.common.none"),
          emptyCreate: l("empty_create"),
          emptyImport: l("empty_import"),
          pageOf: messageTemplate(locale, "crm.common.page_of"),
          previous: tr("crm.common.previous"),
          next: tr("crm.common.next"),
          pagination: tr("crm.common.page_of", { page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) }),
          applyFilters: tr("crm.common.search"),
          filters: tr("crm.common.filters"),
          status: statusBadgeLabels(tr),
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
    </div>
  );
}

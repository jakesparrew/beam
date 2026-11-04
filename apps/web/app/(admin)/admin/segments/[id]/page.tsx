import { notFound } from "next/navigation";
import { Alert, AlertDescription } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { getSegment, listSegments, listTags } from "@/modules/crm/queries";
import { listSegmentMembers, segmentBuilderLabels } from "@/modules/crm/segments/queries";
import { RefreshNowButton, SegmentBuilder, StaticMembers } from "@/modules/crm/ui/segment-builder";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/segments/[id]` (`persons.read`; edit `email.write`), crm spec 5.1: the builder, the
 * refresh error banner (rule 3.41), the last count, refresh now, and for static segments the
 * member list with add by search or CSV of customer numbers.
 */
export default async function SegmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID_RE.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const b = (k: string, p?: Record<string, string | number>) => tr(`crm.segments.builder.${k}`, p);
  const db = await getAppDb();
  const segment = await getSegment(db, id);
  if (!segment) notFound();
  const canEdit = hasPermission(actor, "email.write") && !segment.isArchived;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const [segments, tags, members] = await Promise.all([
    listSegments(db, { includeArchived: false }),
    listTags(db),
    segment.kind === "static" ? listSegmentMembers(db, { segmentId: id, limit: 100, offset: (page - 1) * 100 }) : Promise.resolve(null),
  ]);
  const labels = segmentBuilderLabels(
    tr,
    softTranslator(locale),
    tags.map((t) => ({ value: t.key, label: t.name[locale] ?? t.key })),
  );
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{segment.name}</h1>
          <p className="text-sm text-muted-foreground">
            {segment.lastCount !== null ? b("count", { count: segment.lastCount }) : "—"}
            {segment.lastCountedAt ? ` · ${b("last_counted", { date: dateFmt.format(segment.lastCountedAt) })}` : ""}
          </p>
        </div>
        {canEdit ? <RefreshNowButton segmentId={id} labels={{ refresh: b("refresh_now"), queued: b("refresh_queued"), error: tr("crm.common.error") }} /> : null}
      </div>
      {segment.refreshError ? (
        <Alert variant="destructive">
          <AlertDescription>{b("refresh_error", { error: segment.refreshError })}</AlertDescription>
        </Alert>
      ) : null}
      <SegmentBuilder
        initial={{
          id: segment.id,
          name: segment.name,
          description: segment.description ?? "",
          kind: segment.kind,
          definition: segment.definition,
          excludeSegmentIds: segment.excludeSegmentIds,
        }}
        segments={segments.map((s) => ({ value: s.id, label: s.name }))}
        canEdit={canEdit}
        labels={labels}
      />
      {members ? (
        <StaticMembers
          segmentId={id}
          members={members.rows}
          total={members.total}
          canEdit={canEdit}
          labels={{
            title: b("static_members"),
            add: b("add_member"),
            addCsv: b("add_csv"),
            remove: b("remove_member"),
            search: tr("crm.common.search"),
            empty: b("sample_empty"),
            error: tr("crm.common.error"),
            unknown: tr("crm.common.not_available"),
            count: labels.plural.count,
          }}
        />
      ) : null}
    </div>
  );
}

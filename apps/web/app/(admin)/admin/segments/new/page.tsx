import { EMPTY_SEGMENT_RULE } from "@beam/core/crm";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { listSegments, listTags } from "@/modules/crm/queries";
import { segmentBuilderLabels } from "@/modules/crm/segments/queries";
import { SegmentBuilder } from "@/modules/crm/ui/segment-builder";

/** `/admin/segments/new` (`persons.read`; saving needs `email.write`), crm spec 5.1. */
export default async function NewSegmentPage() {
  const actor = await requireStaff({ permission: "persons.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const [segments, tags] = await Promise.all([listSegments(db, { includeArchived: false }), listTags(db)]);
  const labels = segmentBuilderLabels(
    tr,
    softTranslator(locale),
    tags.map((t) => ({ value: t.key, label: t.name[locale] ?? t.key })),
  );
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{tr("crm.segments.builder.title_new")}</h1>
      <SegmentBuilder
        initial={{ name: "", description: "", kind: "dynamic", definition: EMPTY_SEGMENT_RULE, excludeSegmentIds: [] }}
        segments={segments.map((s) => ({ value: s.id, label: s.name }))}
        canEdit={hasPermission(actor, "email.write")}
        labels={labels}
      />
    </div>
  );
}

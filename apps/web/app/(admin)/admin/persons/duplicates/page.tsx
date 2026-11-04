import { formatDate } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listDuplicateCandidates } from "@/modules/crm/queries";
import { DuplicateList, type DuplicateListItem } from "@/modules/crm/ui/duplicate-list";

/** `/admin/persons/duplicates` (`persons.merge`), crm spec 5.1: open candidate pairs by score. */
export default async function DuplicatesPage() {
  await requireStaff({ permission: "persons.merge" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const rows = await listDuplicateCandidates(db, { status: "open" });
  const items: DuplicateListItem[] = rows.map((r) => {
    const [keep, other] = r.personA.createdAt.getTime() <= r.personB.createdAt.getTime() ? [r.personA, r.personB] : [r.personB, r.personA];
    const view = (p: typeof keep) => ({ id: p.id, customerNumber: p.customerNumber, name: p.name, email: p.email, created: formatDate(p.createdAt, locale) });
    return { id: r.id, score: r.score, reasons: r.reasons.map((x) => tr(`crm.enums.duplicate_reason.${x}`)), keep: view(keep), other: view(other) };
  });
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{tr("crm.duplicates.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("crm.duplicates.intro")}</p>
      </div>
      <DuplicateList
        items={items}
        canMerge
        labels={{
          empty: tr("crm.duplicates.empty"),
          score: tr("crm.duplicates.score", { score: "{score}" }),
          reasons: tr("crm.duplicates.reasons"),
          created: tr("crm.duplicates.created", { date: "{date}" }),
          merge: tr("crm.duplicates.merge"),
          dismiss: tr("crm.duplicates.dismiss"),
          dismissed: tr("crm.duplicates.dismissed"),
          error: tr("crm.common.error"),
        }}
      />
    </div>
  );
}

import { notFound, redirect } from "next/navigation";
import { persons } from "@beam/db/schema";
import { formatCustomerNumber, type MergeField } from "@beam/core/crm";
import { requireStaff } from "@/lib/auth";
import { getAppDb, inArray } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { resolveCanonicalPersonId } from "@/modules/crm/api";
import { getMergePreview } from "@/modules/crm/queries";
import { MergeCompare, type MergeCompareView } from "@/modules/crm/ui/merge-compare";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELD_LABELS: Record<MergeField, string> = {
  email: "crm.persons.new.email",
  phone: "crm.persons.new.phone",
  firstName: "crm.persons.new.first_name",
  lastName: "crm.persons.new.last_name",
  locale: "crm.persons.new.locale",
  address: "crm.persons.new.address",
  birthOn: "crm.persons.new.birth_on",
  preferredChannel: "crm.persons.new.preferred_channel",
  linkedinUrl: "crm.persons.edit.linkedin_url",
  emergencyContact: "crm.persons.edit.emergency_contact",
};

const CONFLICT_LABELS = { membership: "crm.merge.conflict_membership", booking: "crm.merge.conflict_booking", waitlist: "crm.merge.conflict_waitlist" } as const;

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "object") return String(value);
  const v = value as Record<string, unknown>;
  if ("postal_code" in v || "street" in v || "city" in v) {
    return [[v.street, v.number, v.box].filter(Boolean).join(" "), [v.postal_code, v.city].filter(Boolean).join(" "), v.country].filter(Boolean).join(", ");
  }
  if ("name" in v && "phone" in v) return [v.name, v.phone, v.relation].filter(Boolean).join(" · ");
  return JSON.stringify(value);
}

/**
 * `/admin/persons/[id]/merge?with=<id>` (`persons.merge`), crm spec 5.1: `[id]` is the person that
 * stays, `with` the one merged into it. A merged id redirects to its winner.
 */
export default async function MergePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ with?: string }> }) {
  await requireStaff({ permission: "persons.merge" });
  const { id } = await params;
  const other = (await searchParams).with ?? "";
  if (!UUID.test(id) || !UUID.test(other) || id === other) notFound();
  const db = await getAppDb();
  const [winnerId, loserId] = await Promise.all([resolveCanonicalPersonId(db, id).catch(() => null), resolveCanonicalPersonId(db, other).catch(() => null)]);
  if (!winnerId || !loserId || winnerId === loserId) notFound();
  if (winnerId !== id || loserId !== other) redirect(`/admin/persons/${winnerId}/merge?with=${loserId}` as never);

  const preview = await getMergePreview(db, winnerId, loserId).catch(() => null);
  if (!preview) notFound();
  const rows = await db
    .select({ id: persons.id, customerNumber: persons.customerNumber, firstName: persons.firstName, lastName: persons.lastName })
    .from(persons)
    .where(inArray(persons.id, [winnerId, loserId]));
  const side = (pid: string, version: number) => {
    const r = rows.find((x) => x.id === pid)!;
    const customerNumber = formatCustomerNumber(r.customerNumber);
    return { id: pid, customerNumber, name: [r.firstName, r.lastName].filter(Boolean).join(" ") || customerNumber, version };
  };

  const locale = await adminLocale();
  const tr = translator(locale);
  const view: MergeCompareView = {
    winner: side(winnerId, preview.versions.winner),
    loser: side(loserId, preview.versions.loser),
    fields: preview.fields.map((f) => {
      const [w, l] = [show(f.winner), show(f.loser)];
      return { field: f.field, label: tr(FIELD_LABELS[f.field]), winner: w, loser: l, differs: w !== l };
    }),
    counts: Object.entries(preview.counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, count]) => ({ label: tr("crm.merge.count_row", { table: table.split(".")[0]!, count }), count })),
    conflicts: preview.conflicts.map((c) => tr(CONFLICT_LABELS[c])),
  };

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{tr("crm.merge.title")}</h1>
      <MergeCompare
        view={view}
        labels={{
          title: tr("crm.merge.title"),
          intro: tr("crm.merge.intro"),
          field: tr("crm.merge.field"),
          winner: tr("crm.merge.winner"),
          loser: tr("crm.merge.loser"),
          chooseWinner: tr("crm.merge.choose_winner"),
          swap: tr("crm.merge.loser"),
          countsTitle: tr("crm.merge.counts_title"),
          noCounts: tr("crm.common.none"),
          conflictsTitle: tr("crm.merge.conflicts_title"),
          confirmLabel: tr("crm.merge.confirm_label"),
          confirm: tr("crm.merge.confirm"),
          done: tr("crm.merge.done"),
          error: tr("crm.common.error"),
          staleVersion: tr("crm.common.stale_version"),
          empty: "—",
        }}
      />
    </div>
  );
}

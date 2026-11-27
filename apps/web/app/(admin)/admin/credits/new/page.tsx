import Link from "next/link";
import { persons } from "@beam/db/schema";
import { requireStaff } from "@/lib/auth";
import { eq, getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels } from "@/modules/credits/queries";
import { NewGrantForm } from "@/modules/credits/ui/new-grant-form";
import { PageHeader, stepFormLabels } from "@/modules/platform/ui/admin-kit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/credits/new?personId=` (`credits.adjust`, rule 4): a manual or bonus grant. */
export default async function NewGrantPage({ searchParams }: { searchParams: Promise<{ personId?: string }> }) {
  await requireStaff({ permission: "credits.adjust" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  let person: { id: string; name: string; email: string | null } | null = null;
  if (sp.personId && UUID_RE.test(sp.personId)) {
    const [p] = await (await getAppDb())
      .select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName, email: persons.email })
      .from(persons)
      .where(eq(persons.id, sp.personId));
    if (p) person = { id: p.id, name: [p.firstName, p.lastName].filter(Boolean).join(" "), email: p.email };
  }
  const labels = creditsLabels(locale, ["admin.common", "admin.new_grant", "admin.person_picker", "errors", "enum.kind", "enum.source", "enum.sharing_mode"]);
  return (
    <div className="grid gap-6">
      <Link href="/admin/credits" className="w-fit text-[0.8125rem] text-muted-foreground hover:text-foreground">
        ← {tr("credits.admin.grant.back")}
      </Link>
      <PageHeader title={tr("credits.admin.new_grant.title")} description={tr("credits.admin.new_grant.description")} />
      <NewGrantForm labels={labels} person={person} steps={stepFormLabels(tr)} />
    </div>
  );
}

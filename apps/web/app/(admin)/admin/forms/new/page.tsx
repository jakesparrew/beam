import { FORM_KINDS, type FormKind } from "@beam/core/forms";
import { requireStaff } from "@/lib/auth";
import { adminLocale } from "@/lib/i18n";
import { localeNames, screenLabels } from "@/modules/forms/queries";
import { NewFormForm } from "@/modules/forms/ui/admin/form-list";

type Search = { kind?: string; template?: string };

const TEMPLATES = ["blank", "lead", "assessment"] as const;

/** `/admin/forms/new` (`forms.write`): slug, kind, name, locales and template, then the builder. */
export default async function NewFormPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireStaff({ permission: "forms.write" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const labels = screenLabels(locale, ["new", "kind", "builder"]);
  const kind = (FORM_KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as FormKind) : undefined;
  const template = (TEMPLATES as readonly string[]).includes(sp.template ?? "") ? (sp.template as (typeof TEMPLATES)[number]) : undefined;
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{labels["new.title"] ?? "⟦forms.new.title⟧"}</h1>
      <NewFormForm labels={labels} localeNames={localeNames(locale)} initialKind={kind} initialTemplate={template} />
    </div>
  );
}

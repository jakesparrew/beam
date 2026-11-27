import { PageHeader, PrimaryAction, Segmented } from "@/modules/platform/ui/admin-kit";

/**
 * The header of the forms area (owner review, November 2026): Formulieren with "New form" and the
 * tabs Formulieren | Imports, so the ScoreApp and Typeform import sources (`forms.publish`) read
 * as a tab of the forms page instead of a separate destination.
 */
export function FormsHeader({ active, canImports, tr }: { active: "forms" | "imports"; canImports: boolean; tr: (key: string) => string }) {
  return (
    <>
      <PageHeader title={tr("forms.list.title")} description={tr("forms.list.subtitle")} actions={<PrimaryAction href="/admin/forms/new">+ {tr("forms.list.new")}</PrimaryAction>} />
      {canImports ? (
        <Segmented
          label={tr("forms.list.tabs")}
          items={[
            { key: "forms", label: tr("forms.list.title"), href: "/admin/forms", active: active === "forms" },
            { key: "imports", label: tr("forms.imports.title"), href: "/admin/forms/imports", active: active === "imports" },
          ]}
        />
      ) : null}
    </>
  );
}

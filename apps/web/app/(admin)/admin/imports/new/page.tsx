import Link from "next/link";
import { IMPORT_KINDS, IMPORT_SOURCES, type ImportKind, type ImportSource } from "@beam/core/ops";
import { requireStaff } from "@/lib/auth";
import { adminLocale, translator } from "@/lib/i18n";
import { ChunkedUpload } from "@/modules/ops/ui/ChunkedUpload";

/**
 * `/admin/imports/new` (`persons.write`, ops spec 5, rule 42): step 1 kind and source, step 2
 * the chunked upload with progress; step 3, the mapping, is on `/admin/imports/[id]`.
 */
export default async function NewImportPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  await requireStaff({ permission: "persons.write" });
  const sp = await searchParams;
  const tr = translator(await adminLocale());
  const defaultKind = (IMPORT_KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as ImportKind) : "suppressions";
  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/imports" className="text-sm text-muted-foreground hover:underline">
          {tr("ops.imports.title")}
        </Link>
        <h1 className="text-2xl font-semibold">{tr("ops.imports.new")}</h1>
      </div>
      <ChunkedUpload
        defaultKind={defaultKind}
        labels={{
          kind: tr("platform.jobs.col_kind"),
          source: tr("ops.imports.target.source"),
          name: tr("ops.imports.target.name"),
          file: tr("ops.imports.upload"),
          upload: tr("ops.imports.upload"),
          kinds: Object.fromEntries(IMPORT_KINDS.map((k) => [k, tr(`ops.imports.kind.${k}`)])) as Record<ImportKind, string>,
          sources: Object.fromEntries(IMPORT_SOURCES.map((s) => [s, tr(`ops.imports.source.${s}`)])) as Record<ImportSource, string>,
          errors: { tooLarge: tr("platform.errors.validation"), malformed: tr("ops.imports.error.malformed_csv"), generic: tr("platform.errors.internal", { requestId: "-" }) },
        }}
      />
    </div>
  );
}

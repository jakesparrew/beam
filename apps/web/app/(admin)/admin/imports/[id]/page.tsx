import Link from "next/link";
import { notFound } from "next/navigation";
import { products } from "@beam/db/schema";
import { CONSENT_PURPOSES } from "@beam/core/crm";
import { lookupMessage, MESSAGES } from "@beam/core/i18n";
import { detectDelimiter, IMPORT_PRESETS, IMPORT_ROW_STATUSES, IMPORT_SAMPLE_ROWS, parseCsvStream, presetsFor, type ImportMapping, type ImportRowStatus } from "@beam/core/ops";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb, inArray } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { readFile } from "@/modules/platform/api";
import { allowedTargets } from "@/modules/ops/imports/jobs";
import { getImport, listImportRows } from "@/modules/ops/imports/queries";
import { ImportMapper } from "@/modules/ops/ui/ImportMapper";
import { ImportReport } from "@/modules/ops/ui/ImportReport";

/** Message codes with a catalogue text (`ops.imports.error.<code>`). */
const ERROR_CODES = [
  "missing_email",
  "invalid_email",
  "suppressed",
  "erased",
  "existing",
  "no_session",
  "over_capacity",
  "unknown_product",
  "invalid_date",
  "invalid_number",
  "malformed_csv",
  "missing_targets",
  "go_live_gate",
  "dry_run_first",
  "suppressions_first",
  "another_running",
] as const;

async function sampleOf(fileId: string, delimiter: ImportMapping["options"]["delimiter"] | null): Promise<Record<string, string>[]> {
  const file = await readFile(await getAppDb(), fileId);
  if (!file) return [];
  const d = delimiter ?? detectDelimiter(new TextDecoder().decode(file.bytes.subarray(0, 4096)).replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "");
  const out: Record<string, string>[] = [];
  try {
    for await (const r of parseCsvStream([file.bytes], { delimiter: d })) {
      if (out.length >= IMPORT_SAMPLE_ROWS) break;
      out.push(r);
    }
  } catch {
    // A truncated last record of the first part: the rows read so far are enough for the sample.
  }
  return out;
}

/**
 * `/admin/imports/[id]` (`persons.write`; run and sign-off `settings.write`, ops spec 5): the
 * mapping step while the import is `uploaded` or in `dry_run`, the live status, the dry-run and
 * run reports, the reconciliation with its sign-off, and the rows filtered by status.
 */
export default async function ImportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; page?: string }> }) {
  const actor = await requireStaff({ permission: "persons.write" });
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const imp = await getImport(db, id);
  if (!imp) notFound();

  const mapping = "columns" in imp.mapping ? (imp.mapping as ImportMapping) : null;
  const editable = imp.status === "uploaded" || (imp.status === "dry_run" && !!imp.finishedAt);
  const sample = editable ? await sampleOf(imp.fileId, mapping?.options.delimiter ?? null) : [];
  const targets = [...allowedTargets(imp.kind, imp.source)];
  const productRows = imp.kind === "packages" ? await db.select({ id: products.id, sku: products.sku }).from(products).where(inArray(products.kind, ["package", "voucher"])) : [];

  const status = (IMPORT_ROW_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as ImportRowStatus) : undefined;
  const dry = imp.status === "dry_run" || (imp.isDryRun && imp.status !== "done");
  const rows = await listImportRows(db, imp.id, { status, dry, page: Number(sp.page) || 1 });
  const codeLabel = (code: string | null) => (code ? (lookupMessage(MESSAGES, locale, `ops.imports.error.${code}`) ?? code) : "");
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" });
  const targetLabels = Object.fromEntries(targets.map((t) => [t, lookupMessage(MESSAGES, locale, `ops.imports.target.${t}`) ?? t]));
  const rowStatus = Object.fromEntries(IMPORT_ROW_STATUSES.map((s) => [s, tr(`ops.imports.row_status.${s}`)])) as Record<ImportRowStatus, string>;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin/imports" className="text-sm text-muted-foreground hover:underline">
          {tr("ops.imports.title")}
        </Link>
        <h1 className="text-2xl font-semibold">{imp.name}</h1>
        <span className="text-sm text-muted-foreground">
          {tr(`ops.imports.kind.${imp.kind}`)} · {tr(`ops.imports.source.${imp.source}`)} · {tr("ops.imports.report.rows", { count: imp.rowCount })}
        </span>
      </div>

      {editable ? (
        <ImportMapper
          importId={imp.id}
          kind={imp.kind}
          header={imp.header}
          sample={sample}
          targets={targets}
          mapping={mapping}
          presets={presetsFor(imp.source, imp.kind).map((key) => ({ key, columns: { ...IMPORT_PRESETS[key].columns }, delimiter: IMPORT_PRESETS[key].delimiter, dateFormat: IMPORT_PRESETS[key].dateFormat }))}
          products={productRows.map((p) => ({ id: p.id, label: p.sku }))}
          consentPurposes={[...CONSENT_PURPOSES]}
          labels={{
            targets: targetLabels,
            unmapped: tr("ops.imports.target.unmapped"),
            options: {
              delimiter: tr("ops.imports.option.delimiter"),
              dateFormat: tr("ops.imports.option.date_format"),
              defaultLocale: tr("ops.imports.option.default_locale"),
              overwrite: tr("ops.imports.option.overwrite"),
              consentPurpose: tr("ops.imports.option.consent_purpose"),
              consentWordingVersion: tr("ops.imports.option.consent_wording_version"),
              product: tr("ops.imports.option.product"),
              creditKind: tr("ops.imports.option.credit_kind"),
              tagKey: tr("ops.imports.option.tag_key"),
              preset: tr("ops.imports.option.preset"),
            },
            locales: { "nl-BE": "Nederlands", "fr-BE": "Français", en: "English" },
            saveMapping: tr("ops.imports.save_mapping"),
            startDryRun: tr("ops.imports.start_dry_run"),
            missingTargets: tr("ops.imports.error.missing_targets", { targets: "{targets}" }),
            saved: tr("platform.go_live.saved"),
            error: tr("platform.errors.conflict"),
          }}
        />
      ) : null}

      <ImportReport
        importId={imp.id}
        kind={imp.kind}
        status={imp.status}
        dryRunFinished={imp.status === "dry_run" && !!imp.finishedAt}
        counts={imp.counts}
        rowCount={imp.rowCount}
        report={imp.report}
        reconciliation={imp.reconciliation}
        canRun={hasPermission(actor, "settings.write")}
        canSignOff={hasPermission(actor, "settings.write")}
        signedOff={!!imp.signedOffAt}
        labels={{
          status: tr(`ops.imports.status.${imp.status}`),
          dryRunTitle: tr("ops.imports.report.dry_run_title"),
          runTitle: tr("ops.imports.report.title"),
          rowStatus,
          newPersons: tr("ops.imports.report.new_persons"),
          matchedPersons: tr("ops.imports.report.matched_persons"),
          duplicates: tr("ops.imports.report.duplicates_in_file"),
          invalidEmails: tr("ops.imports.report.invalid_emails"),
          unknownProducts: tr("ops.imports.report.unknown_products"),
          suppressedSkipped: tr("ops.imports.report.suppressed_skipped"),
          overCapacity: tr("ops.imports.report.over_capacity"),
          partial: tr("ops.imports.report.partial"),
          reconciliation: tr("ops.imports.report.reconciliation"),
          unitsInFile: tr("ops.imports.report.units_in_file"),
          unitsGranted: tr("ops.imports.report.units_granted"),
          difference: tr("ops.imports.report.difference"),
          signedOff: imp.signedOffAt ? tr("ops.imports.report.signed_off", { name: imp.signedOffBy ?? "-", date: fmt.format(imp.signedOffAt) }) : null,
          run: tr("ops.imports.start_run"),
          cancel: tr("ops.imports.cancel"),
          signOff: tr("ops.imports.sign_off"),
          note: tr("platform.go_live.note"),
          downloadErrors: tr("ops.imports.download_errors"),
          confirmNoSuppressionSource: tr("ops.imports.option.confirm_no_suppression_source"),
          confirmDifferentFile: lookupMessage(MESSAGES, locale, "ops.imports.option.confirm_different_file") ?? tr("platform.go_live.confirm"),
          errors: Object.fromEntries(ERROR_CODES.map((c) => [c, tr(`ops.imports.error.${c}`)])),
          genericError: tr("platform.errors.conflict"),
          failed: imp.status === "failed" && imp.report.error ? codeLabel(imp.report.error) : null,
        }}
      />

      <section className="grid gap-2">
        <nav className="flex flex-wrap gap-2 text-sm" aria-label={tr("platform.table.filters")}>
          <Link href={`/admin/imports/${imp.id}`} aria-current={!status ? "page" : undefined} className={!status ? "font-semibold" : "text-muted-foreground"}>
            {tr("ops.imports.report.rows", { count: imp.rowCount })}
          </Link>
          {IMPORT_ROW_STATUSES.map((s) => (
            <Link key={s} href={{ pathname: `/admin/imports/${imp.id}`, query: { status: s } }} aria-current={status === s ? "page" : undefined} className={status === s ? "font-semibold" : "text-muted-foreground"}>
              {rowStatus[s]} ({imp.counts[s] ?? 0})
            </Link>
          ))}
        </nav>
        {rows.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr("ops.common.no_data")}</p>
        ) : (
          <table className="w-full max-w-3xl text-sm" data-testid="import-rows">
            <tbody>
              {rows.items.map((r) => (
                <tr key={r.rowNumber} className="border-t">
                  <td className="py-1 pr-4 tabular-nums">{r.rowNumber}</td>
                  <td className="py-1 pr-4">{rowStatus[(dry ? r.dryRunStatus : r.status) ?? "pending"]}</td>
                  <td className="py-1">{codeLabel(r.message)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

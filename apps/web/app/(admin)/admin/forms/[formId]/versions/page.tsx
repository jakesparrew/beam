import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, buttonVariants, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { diffFormVersions, getForm, listVersions, screenLabels } from "@/modules/forms/queries";
import { RestoreButton } from "@/modules/forms/ui/admin/form-list";
import { VersionDiff } from "@/modules/forms/ui/admin/version-diff";

type Search = { a?: string; b?: string };
const UUID = /^[0-9a-f-]{36}$/i;

/** `/admin/forms/[formId]/versions` (`forms.write`): every version, compare two, restore one as draft. */
export default async function FormVersionsPage({ params, searchParams }: { params: Promise<{ formId: string }>; searchParams: Promise<Search> }) {
  await requireStaff({ permission: "forms.write" });
  const { formId } = await params;
  const sp = await searchParams;
  if (!UUID.test(formId)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const v = (k: string, p?: Record<string, string | number>) => tr(`forms.versions.${k}`, p);
  const db = await getAppDb();
  const form = await getForm(db, formId);
  if (!form) notFound();
  const rows = await listVersions(db, formId);
  const labels = screenLabels(locale, ["versions", "builder"]);
  const diff = sp.a && sp.b && UUID.test(sp.a) && UUID.test(sp.b) ? await diffFormVersions(db, sp.a, sp.b) : null;
  const published = rows.filter((r) => r.publishedAt);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{v("title", { name: form.name[locale] || form.slug })}</h1>
        <Link className="text-sm underline" href={`/admin/forms/${form.id}`}>
          {tr("forms.builder.back_to_overview")}
        </Link>
      </header>
      {!published.length ? <EmptyState title={v("not_published")} /> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{v("version")}</TableHead>
            <TableHead>{v("published_at")}</TableHead>
            <TableHead>{v("published_by")}</TableHead>
            <TableHead>{v("change_note")}</TableHead>
            <TableHead className="text-right">{v("submissions")}</TableHead>
            <TableHead>{v("actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} data-version={r.version}>
              <TableCell>
                <span className="flex items-center gap-2">
                  v{r.version}
                  {r.isCurrent ? <Badge variant="success">{v("current")}</Badge> : null}
                  {!r.publishedAt ? <Badge variant="warning">{v("draft")}</Badge> : null}
                </span>
              </TableCell>
              <TableCell>{r.publishedAt ? formatDateTime(r.publishedAt, locale) : "–"}</TableCell>
              <TableCell>{r.publishedAt ? (r.publishedByName ?? v("by_seed")) : "–"}</TableCell>
              <TableCell>{r.changeNote ?? ""}</TableCell>
              <TableCell className="text-right">{r.submissions}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-2">
                  <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href={`/admin/forms/${form.id}/preview?version=${r.id}`}>
                    {v("view")}
                  </Link>
                  {r.publishedAt && !form.draft ? <RestoreButton formId={form.id} versionId={r.id} labels={labels} /> : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length > 1 ? (
        <form className="flex flex-wrap items-end gap-3" method="get" aria-label={v("compare")}>
          <label className="grid gap-1 text-sm">
            {v("compare_from")}
            <select name="a" defaultValue={sp.a ?? rows[1]?.id} className="h-9 rounded-md border bg-background px-2 text-sm">
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.version}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {v("compare_to")}
            <select name="b" defaultValue={sp.b ?? rows[0]?.id} className="h-9 rounded-md border bg-background px-2 text-sm">
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.version}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonVariants({ variant: "outline" })}>
            {v("compare")}
          </button>
        </form>
      ) : null}
      {diff ? <VersionDiff diff={diff} labels={labels} /> : null}
    </div>
  );
}

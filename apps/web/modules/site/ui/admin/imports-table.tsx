"use client";
/**
 * WordPress imports (site spec section 5 `/admin/site/imports`, `site.publish`): the upload form
 * (WXR `.xml` up to 10 MB, old site address, default language) and the imports with status and
 * counts. A file over 10 MB is refused before upload (rule 65).
 */
import { useState, useTransition } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, EmptyState, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { startWordpressImport } from "../../actions/wordpress";
import type { SiteAdminLabels } from "../../queries/admin";
import type { WordpressImportStatus, WordpressImportSummary } from "../../queries/wordpress";
import { lbl, selectClass } from "./pickers";

const MAX_BYTES = 10_485_760;

/** `key` when the catalogue has it, else `fallback` (keys requested from the catalogue owner). */
export const lblOr = (L: SiteAdminLabels, key: string, fallback: string): string => L[key] ?? lbl(L, fallback);
const LOCALE_NAMES: Record<Locale, string> = { "nl-BE": "Nederlands", "fr-BE": "Français", en: "English" };

export function importStatusVariant(status: WordpressImportStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "done") return "default";
  if (status === "parsed") return "secondary";
  return "outline";
}

/** The counts of an import as short labelled numbers (reusing the catalogue's kind and status labels). */
export function ImportCounts({ counts, L }: { counts: WordpressImportSummary["counts"]; L: SiteAdminLabels }) {
  const parts: [string, number | undefined][] = [
    [lbl(L, "kind.standard"), counts.pages],
    [lbl(L, "kind.post"), counts.posts],
    [lbl(L, "nav.media"), counts.attachments],
    [lbl(L, "import.itemStatus.imported"), counts.imported],
    [lbl(L, "import.itemStatus.skipped"), counts.skipped],
    [lbl(L, "import.itemStatus.error"), counts.errors],
    [lbl(L, "nav.redirects"), counts.redirects],
  ];
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {parts
        .filter(([, n]) => n !== undefined)
        .map(([label, n]) => (
          <div key={label} className="flex gap-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{n}</dd>
          </div>
        ))}
    </dl>
  );
}

export function ImportsTable({ rows, L, locale }: { rows: WordpressImportSummary[]; L: SiteAdminLabels; locale: Locale }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" }).format(new Date(iso)) : "—");

  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const file = data.get("file");
    if (file instanceof File && file.size > MAX_BYTES) return setMsg(lbl(L, "import.tooLarge"));
    setMsg(null);
    start(async () => {
      const res = await startWordpressImport(data);
      if (res.ok) {
        form.reset();
        router.push(`/admin/site/imports/${res.data.importId}`);
        return;
      }
      setMsg(res.error.fields?.file === "too_large" ? lbl(L, "import.tooLarge") : res.error.fields ? Object.entries(res.error.fields).map(([k, v]) => `${k}: ${v}`).join("; ") : res.error.message);
    });
  };

  return (
    <div className="grid gap-6">
      <form
        className="grid max-w-2xl gap-3 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit(e.currentTarget);
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="wp-file">{lbl(L, "import.upload")}</Label>
          <Input id="wp-file" name="file" type="file" accept=".xml,application/xml,text/xml" required />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="wp-origin">{lbl(L, "import.siteOrigin")}</Label>
            <Input id="wp-origin" name="siteOrigin" type="url" inputMode="url" placeholder="https://www.beam.be" defaultValue="https://www.beam.be" required pattern="https://.*" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="wp-locale">{lbl(L, "import.defaultLocale")}</Label>
            <select id="wp-locale" name="defaultLocale" defaultValue="nl-BE" className={selectClass}>
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_NAMES[l]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {msg ? (
          <p role="alert" className="text-sm text-destructive">
            {msg}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? lbl(L, "common.loading") : lbl(L, "import.upload")}
          </Button>
        </div>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={lbl(L, "import.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{lbl(L, "import.siteOrigin")}</TableHead>
              <TableHead>{lbl(L, "pages.col.status")}</TableHead>
              <TableHead>{lblOr(L, "import.col.counts", "nav.pages")}</TableHead>
              <TableHead>{lblOr(L, "import.col.appliedAt", "import.status.done")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.importId}>
                <TableCell>
                  <NextLink href={`/admin/site/imports/${r.importId}`} className="font-medium underline-offset-4 hover:underline">
                    {r.siteOrigin}
                  </NextLink>
                  <div className="text-xs text-muted-foreground">
                    {date(r.createdAt)}
                    {r.createdBy ? ` · ${r.createdBy}` : ""}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={importStatusVariant(r.status)}>{lbl(L, `import.status.${r.status}`)}</Badge>
                </TableCell>
                <TableCell>
                  <ImportCounts counts={r.counts} L={L} />
                </TableCell>
                <TableCell>{date(r.appliedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

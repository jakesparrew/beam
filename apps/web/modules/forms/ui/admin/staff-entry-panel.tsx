"use client";

/**
 * Staff-assisted entry (forms spec section 5 `/admin/forms/enter`, rule ID10; forms-P6): the
 * forms that allow staff entry, each with a language choice and Start, which calls
 * `startStaffEntry` and opens the hosted form (2-hour staff identity token) in a new tab.
 */
import { useState } from "react";
import type { Locale } from "@beam/core/i18n";
import { Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast } from "@beam/ui";
import { startStaffEntry } from "../../actions";
import { selectClass } from "./condition-builder";
import { lbl, type Labels } from "./issues-panel";

export type StaffEntryFormView = { formId: string; slug: string; name: string; kindLabel: string; locales: Locale[] };

function StartRow({ form, personId, defaultLocale, localeNames, labels }: { form: StaffEntryFormView; personId: string; defaultLocale: Locale; localeNames: Record<Locale, string>; labels: Labels }) {
  const [locale, setLocale] = useState<Locale>(form.locales.includes(defaultLocale) ? defaultLocale : form.locales[0]!);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    const r = await startStaffEntry({ formId: form.formId, personId, locale });
    setBusy(false);
    if (!r.ok) {
      toast.error(lbl(labels, `builder.error.${r.error.code}`));
      return;
    }
    setUrl(r.data.url);
    const opened = window.open(r.data.url, "_blank", "noopener");
    if (opened) toast.success(lbl(labels, "enter.started"));
  };
  return (
    <TableRow data-form-slug={form.slug}>
      <TableCell className="font-medium">{form.name}</TableCell>
      <TableCell>{form.kindLabel}</TableCell>
      <TableCell>
        <label className="sr-only" htmlFor={`locale-${form.formId}`}>
          {lbl(labels, "enter.language")}
        </label>
        <select id={`locale-${form.formId}`} className={selectClass} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          {form.locales.map((l) => (
            <option key={l} value={l}>
              {localeNames[l]}
            </option>
          ))}
        </select>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          {url ? (
            <a className="text-sm underline" href={url} target="_blank" rel="noopener noreferrer">
              {lbl(labels, "enter.open_link")}
            </a>
          ) : null}
          <Button type="button" disabled={busy} onClick={() => void start()}>
            {lbl(labels, "enter.start")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function StaffEntryPanel(props: { personId: string; defaultLocale: Locale; forms: StaffEntryFormView[]; localeNames: Record<Locale, string>; labels: Labels }) {
  const { forms, labels } = props;
  if (!forms.length) return <EmptyState title={lbl(labels, "enter.empty")} />;
  return (
    <section className="grid gap-3" aria-labelledby="staff-entry-forms">
      <h2 id="staff-entry-forms" className="text-lg font-semibold">
        {lbl(labels, "enter.forms_title")}
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{lbl(labels, "list.name")}</TableHead>
            <TableHead>{lbl(labels, "list.kind")}</TableHead>
            <TableHead>{lbl(labels, "enter.language")}</TableHead>
            <TableHead className="text-right" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {forms.map((f) => (
            <StartRow key={f.formId} form={f} personId={props.personId} defaultLocale={props.defaultLocale} localeNames={props.localeNames} labels={labels} />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

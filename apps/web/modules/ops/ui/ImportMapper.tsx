"use client";
/**
 * Step 3 of an import (ops spec 5, rules 42-44): every CSV column next to a target field of the
 * kind, the first 20 rows, the options (delimiter, date format, default language, overwrite,
 * consent purpose and wording, product, credit kind, tag) and a preset of the old tool. "Save
 * mapping" stores it and lists the required targets still missing; "Start dry run" saves and
 * starts the dry run. Every string comes from the page.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@beam/ui";
import type { ImportMapping } from "@beam/core/ops";
import { saveImportMapping, startDryRun } from "@/modules/ops/imports/actions";

export type MapperPreset = { key: string; columns: Record<string, string>; delimiter: ImportMapping["options"]["delimiter"]; dateFormat: ImportMapping["options"]["dateFormat"] };

export type ImportMapperLabels = {
  targets: Record<string, string>;
  unmapped: string;
  options: Record<"delimiter" | "dateFormat" | "defaultLocale" | "overwrite" | "consentPurpose" | "consentWordingVersion" | "product" | "creditKind" | "tagKey" | "preset", string>;
  locales: Record<"nl-BE" | "fr-BE" | "en", string>;
  saveMapping: string;
  startDryRun: string;
  /** The sentence with a `{targets}` placeholder. */
  missingTargets: string;
  saved: string;
  error: string;
};

type Props = {
  importId: string;
  kind: string;
  header: string[];
  sample: Record<string, string>[];
  targets: string[];
  mapping: ImportMapping | null;
  presets: MapperPreset[];
  products: { id: string; label: string }[];
  consentPurposes: string[];
  labels: ImportMapperLabels;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A first guess: a preset's columns, else headers whose normalised name equals a target. */
function suggest(header: string[], targets: string[], preset: MapperPreset | undefined): Record<string, string | null> {
  return Object.fromEntries(header.map((h) => [h, preset?.columns[h] ?? targets.find((t) => norm(t) === norm(h)) ?? null]));
}

export function ImportMapper({ importId, kind, header, sample, targets, mapping, presets, products, consentPurposes, labels }: Props) {
  const router = useRouter();
  const [preset, setPreset] = useState<string>(mapping?.options.preset ?? "");
  const [columns, setColumns] = useState<Record<string, string | null>>(() => ({ ...suggest(header, targets, presets.find((p) => p.key === mapping?.options.preset)), ...(mapping?.columns ?? {}) }));
  const [options, setOptions] = useState<ImportMapping["options"]>(() => mapping?.options ?? { delimiter: ",", dateFormat: "iso", defaultLocale: "nl-BE", overwrite: false });
  const [missing, setMissing] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = useMemo<ImportMapping>(() => {
    const opts = { ...options, ...(preset ? { preset } : {}) };
    if (!preset) delete (opts as { preset?: string }).preset;
    for (const k of Object.keys(opts) as (keyof typeof opts)[]) if (opts[k] === "" || opts[k] === undefined) delete opts[k];
    return { columns, options: opts };
  }, [columns, options, preset]);

  function applyPreset(key: string) {
    setPreset(key);
    const p = presets.find((x) => x.key === key);
    if (p) {
      setColumns(suggest(header, targets, p));
      setOptions((o) => ({ ...o, delimiter: p.delimiter, dateFormat: p.dateFormat }));
    }
  }

  async function save(): Promise<boolean> {
    setMessage(null);
    const res = await saveImportMapping({ importId, mapping: current });
    if (!res.ok) {
      setMessage(labels.error);
      return false;
    }
    setMissing(res.data.missingTargets);
    if (res.data.ok) setMessage(labels.saved);
    return res.data.ok;
  }

  async function run(withDryRun: boolean) {
    setBusy(true);
    try {
      const ok = await save();
      if (ok && withDryRun) {
        const res = await startDryRun({ importId });
        if (!res.ok) setMessage(labels.error);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const input = "h-9 rounded-md border bg-background px-2 text-sm";
  const opt = <K extends keyof ImportMapping["options"]>(key: K, value: ImportMapping["options"][K]) => setOptions((o) => ({ ...o, [key]: value }));
  return (
    <div className="grid gap-6" data-testid="import-mapper">
      {presets.length ? (
        <label className="grid max-w-sm gap-1 text-sm">
          <span className="font-medium">{labels.options.preset}</span>
          <select name="preset" className={input} value={preset} onChange={(e) => applyPreset(e.target.value)}>
            <option value="">{labels.unmapped}</option>
            {presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {header.map((h) => (
                <th key={h} className="px-2 py-2 text-left align-top font-medium">
                  <div className="mb-1">{h}</div>
                  <select
                    aria-label={h}
                    data-column={h}
                    className={input}
                    value={columns[h] ?? ""}
                    onChange={(e) => setColumns((c) => ({ ...c, [h]: e.target.value || null }))}
                  >
                    <option value="">{labels.unmapped}</option>
                    {targets.map((t) => (
                      <option key={t} value={t}>
                        {labels.targets[t] ?? t}
                      </option>
                    ))}
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.map((r, i) => (
              <tr key={i} className="border-t">
                {header.map((h) => (
                  <td key={h} className="max-w-48 truncate px-2 py-1 text-muted-foreground">
                    {r[h]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{labels.options.delimiter}</span>
          <select name="delimiter" className={input} value={options.delimiter} onChange={(e) => opt("delimiter", e.target.value as ImportMapping["options"]["delimiter"])}>
            <option value=",">,</option>
            <option value=";">;</option>
            <option value={"\t"}>Tab</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{labels.options.dateFormat}</span>
          <select name="dateFormat" className={input} value={options.dateFormat} onChange={(e) => opt("dateFormat", e.target.value as ImportMapping["options"]["dateFormat"])}>
            <option value="iso">YYYY-MM-DD</option>
            <option value="dd/mm/yyyy">DD/MM/YYYY</option>
            <option value="mm/dd/yyyy">MM/DD/YYYY</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{labels.options.defaultLocale}</span>
          <select name="defaultLocale" className={input} value={options.defaultLocale} onChange={(e) => opt("defaultLocale", e.target.value as ImportMapping["options"]["defaultLocale"])}>
            {(Object.keys(labels.locales) as (keyof ImportMapperLabels["locales"])[]).map((l) => (
              <option key={l} value={l}>
                {labels.locales[l]}
              </option>
            ))}
          </select>
        </label>
        {kind === "persons" || kind === "companies" ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="overwrite" checked={options.overwrite} onChange={(e) => opt("overwrite", e.target.checked)} />
            <span>{labels.options.overwrite}</span>
          </label>
        ) : null}
        {kind === "consents" ? (
          <>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{labels.options.consentPurpose}</span>
              <select name="consentPurpose" className={input} value={options.consentPurpose ?? ""} onChange={(e) => opt("consentPurpose", (e.target.value || undefined) as ImportMapping["options"]["consentPurpose"])}>
                <option value="">{labels.unmapped}</option>
                {consentPurposes.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{labels.options.consentWordingVersion}</span>
              <input name="consentWordingVersion" className={input} maxLength={64} value={options.consentWordingVersion ?? ""} onChange={(e) => opt("consentWordingVersion", e.target.value || undefined)} />
            </label>
          </>
        ) : null}
        {kind === "packages" ? (
          <>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{labels.options.product}</span>
              <select name="productId" className={input} value={options.productId ?? ""} onChange={(e) => opt("productId", e.target.value || undefined)}>
                <option value="">{labels.unmapped}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{labels.options.creditKind}</span>
              <select name="creditKind" className={input} value={options.creditKind ?? ""} onChange={(e) => opt("creditKind", (e.target.value || undefined) as ImportMapping["options"]["creditKind"])}>
                <option value="">{labels.unmapped}</option>
                <option value="day">day</option>
                <option value="night">night</option>
                <option value="euro">euro</option>
              </select>
            </label>
          </>
        ) : null}
        {kind === "tags" ? (
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{labels.options.tagKey}</span>
            <input name="tagKey" className={input} maxLength={64} value={options.tagKey ?? ""} onChange={(e) => opt("tagKey", e.target.value || undefined)} />
          </label>
        ) : null}
      </div>

      {missing && missing.length ? (
        <p className="text-sm text-destructive" data-testid="missing-targets">
          {labels.missingTargets.replace("{targets}", missing.map((m) => m.split(/[|+]/).map((t) => labels.targets[t.replace("option:", "")] ?? t).join(" / ")).join(", "))}
        </p>
      ) : null}
      {message ? (
        <p className="text-sm" role="status">
          {message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => run(false)}>
          {labels.saveMapping}
        </Button>
        <Button type="button" disabled={busy} onClick={() => run(true)}>
          {labels.startDryRun}
        </Button>
      </div>
    </div>
  );
}

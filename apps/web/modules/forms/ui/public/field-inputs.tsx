"use client";

/**
 * The visitor inputs of the hosted form (forms spec section 5 "Public", rule F2). WCAG 2.1 AA:
 * every input has a visible `<label>`; choice, yes/no and rating groups are `fieldset`/`legend`
 * with native radios or checkboxes (arrow keys move within a radio group); required is marked in
 * text, not colour only; errors are linked with `aria-describedby` and `aria-invalid`; touch
 * targets are at least 44 px. `Markdown` renders the F5 subset (paragraphs, bold, italic,
 * https links, lists) without HTML injection.
 */
import { Fragment, type ReactNode } from "react";
import type { AnswerValue, Field } from "@beam/core/forms";
import type { Locale, LocalizedText } from "@beam/core/i18n";

export type PublicLabels = Readonly<Record<string, string>>;

const lt = (t: LocalizedText | undefined, locale: Locale): string => (t ? (t[locale] ?? "") : "");

// ---------------------------------------------------------------------------
// Markdown subset (F5)
// ---------------------------------------------------------------------------

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https:\/\/[^\s)]+)\))/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[2]) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3]}</em>);
    else if (m[4] && m[5]) {
      out.push(
        <a key={k} href={m[5]} rel="noopener noreferrer" target="_blank" className="underline">
          {m[4]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Paragraphs, `**bold**`, `*italic*`, `[text](https://…)` and `- ` lists; everything else is text. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className={className ?? "space-y-2"}>
      {blocks.map((b, bi) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*[-*]\s+/, ""), `${bi}-${li}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {inline(l, `${bi}-${li}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type FieldInputProps = {
  field: Field;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue | undefined) => void;
  locale: Locale;
  labels: PublicLabels;
  /** The error code of this field (`required`, `invalid_email`, ...). */
  error?: string | undefined;
  idPrefix: string;
  readOnly?: boolean;
  /** ID10: the extra line under the `sensitive_processing` consent in staff-assisted entry. */
  staffEntry?: boolean;
};

const ERROR_KEYS: Record<string, string> = {
  out_of_range: "number_range",
  invalid_step: "number_range",
};

/** The visitor-facing text of an error code. */
export function errorText(code: string, labels: PublicLabels): string {
  const key = ERROR_KEYS[code] ?? code;
  return labels[key] ?? labels.invalid ?? code;
}

export const inputClass =
  "block min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";
const choiceRow = "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 has-[:checked]:border-primary";
const box = "size-5 shrink-0 accent-primary";

function RequiredMark({ field, labels }: { field: Field; labels: PublicLabels }) {
  const required = field.required || field.type === "acknowledgement";
  return <span className="ml-1 text-sm font-normal text-muted-foreground">{required ? labels.required_mark : labels.optional_mark}</span>;
}

function Help({ id, field, locale }: { id: string; field: Field; locale: Locale }) {
  const help = lt(field.help, locale);
  return help ? (
    <p id={`${id}-help`} className="text-sm text-muted-foreground">
      {help}
    </p>
  ) : null;
}

function ErrorLine({ id, error, labels }: { id: string; error: string | undefined; labels: PublicLabels }) {
  return error ? (
    <p id={`${id}-error`} className="text-sm font-medium text-destructive">
      {errorText(error, labels)}
    </p>
  ) : null;
}

function describedBy(id: string, field: Field, error: string | undefined, locale: Locale): string | undefined {
  const ids = [lt(field.help, locale) ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

/** One field of a section; `hidden` and `utm` fields are never rendered (F3). */
export function FieldInput(p: FieldInputProps) {
  const { field, value, onChange, locale, labels, error, idPrefix } = p;
  const id = `${idPrefix}-${field.key}`;
  const label = lt(field.label, locale);
  const invalid = error ? true : undefined;
  const desc = describedBy(id, field, error, locale);

  if (field.type === "hidden" || field.type === "utm") return null;

  if (field.type === "single_choice" || field.type === "multiple_choice" || field.type === "yes_no" || field.type === "rating") {
    const multiple = field.type === "multiple_choice";
    const options: { key: string; label: string; value: AnswerValue }[] =
      field.type === "yes_no"
        ? [
            { key: "yes", label: labels.yes ?? "Yes", value: true },
            { key: "no", label: labels.no ?? "No", value: false },
          ]
        : field.type === "rating"
          ? Array.from({ length: field.scale }, (_, i) => ({ key: String(i + 1), label: String(i + 1), value: i + 1 }))
          : field.options.map((o) => ({ key: o.key, label: lt(o.label, locale), value: o.key }));
    const selected = (v: AnswerValue): boolean => (multiple ? Array.isArray(value) && (value as string[]).includes(v as string) : value === v);
    const toggle = (v: AnswerValue) => {
      if (!multiple) return onChange(v);
      const cur = Array.isArray(value) ? (value as string[]) : [];
      const next = cur.includes(v as string) ? cur.filter((x) => x !== v) : [...cur, v as string];
      onChange(next.length ? next : undefined);
    };
    return (
      <fieldset id={id} className="space-y-2" aria-describedby={desc} aria-invalid={invalid} tabIndex={-1}>
        <legend className="mb-1 text-base font-medium">
          {label}
          <RequiredMark field={field} labels={labels} />
        </legend>
        <Help id={id} field={field} locale={locale} />
        <div className={field.type === "rating" ? "flex flex-wrap gap-2" : "space-y-2"}>
          {options.map((o) => (
            <label key={o.key} className={field.type === "rating" ? `${choiceRow} min-w-11 justify-center` : choiceRow}>
              <input
                type={multiple ? "checkbox" : "radio"}
                name={id}
                value={o.key}
                className={box}
                checked={selected(o.value)}
                onChange={() => toggle(o.value)}
                aria-label={field.type === "rating" ? (labels.rating_value ?? "{value}").replace("{value}", o.label).replace("{scale}", String(field.scale)) : undefined}
                disabled={p.readOnly}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
        <ErrorLine id={id} error={error} labels={labels} />
      </fieldset>
    );
  }

  if (field.type === "consent" || field.type === "acknowledgement") {
    const text = field.type === "consent" ? lt(field.wording, locale) : lt(field.text, locale);
    return (
      <div className="space-y-2">
        {field.type === "acknowledgement" ? <Markdown text={text} className="space-y-2 text-sm" /> : null}
        <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            id={id}
            type="checkbox"
            className={`${box} mt-0.5`}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked ? true : undefined)}
            aria-describedby={desc}
            aria-invalid={invalid}
            disabled={p.readOnly}
          />
          <span>
            {field.type === "consent" ? text : label}
            <RequiredMark field={field} labels={labels} />
          </span>
        </label>
        {p.staffEntry && field.type === "consent" && field.purpose === "sensitive_processing" ? <p className="text-sm text-muted-foreground">{labels.guest_confirmed}</p> : null}
        <Help id={id} field={field} locale={locale} />
        <ErrorLine id={id} error={error} labels={labels} />
      </div>
    );
  }

  let control: ReactNode;
  const common = {
    id,
    className: inputClass,
    "aria-describedby": desc,
    "aria-invalid": invalid,
    "aria-required": field.required || undefined,
    readOnly: p.readOnly,
    placeholder: lt(field.placeholder, locale) || undefined,
  };
  switch (field.type) {
    case "dropdown":
      control = (
        <select {...common} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} disabled={p.readOnly}>
          <option value="">{labels.choose}</option>
          {field.options.map((o) => (
            <option key={o.key} value={o.key}>
              {lt(o.label, locale)}
            </option>
          ))}
        </select>
      );
      break;
    case "long_text":
      control = <textarea {...common} rows={5} maxLength={field.maxLength ?? 5000} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
      break;
    case "number":
      control = (
        <input
          {...common}
          type="number"
          inputMode="decimal"
          min={field.min}
          max={field.max}
          step={field.step ?? "any"}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
      break;
    case "date":
      control = <input {...common} type="date" min={field.min} max={field.max} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
      break;
    case "email":
      control = <input {...common} type="email" autoComplete="email" maxLength={254} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
      break;
    case "phone":
      control = <input {...common} type="tel" autoComplete="tel" maxLength={40} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
      break;
    default: {
      const auto = field.mapsTo === "person.first_name" ? "given-name" : field.mapsTo === "person.last_name" ? "family-name" : undefined;
      control = (
        <input {...common} type="text" autoComplete={auto} maxLength={field.type === "short_text" ? (field.maxLength ?? 255) : undefined} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />
      );
    }
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-base font-medium">
        {label}
        <RequiredMark field={field} labels={labels} />
      </label>
      <Help id={id} field={field} locale={locale} />
      {control}
      <ErrorLine id={id} error={error} labels={labels} />
    </div>
  );
}

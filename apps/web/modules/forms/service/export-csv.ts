/**
 * Staff CSV export of submissions (forms spec section 5 `/admin/forms/[formId]/submissions/export`,
 * SE4; forms-P6). Non-sensitive columns only: a field in the version's `sensitive_field_keys` or
 * marked sensitive never gets a column, and `answers` never holds a sensitive value anyway (SE1).
 * Every cell is quoted (RFC 4180) and guarded against CSV injection: a text cell starting with
 * `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`. Also the shared answer
 * formatting of the submission detail. Pure: no database, no server-only import.
 */
import type { FormVersionRow } from "@beam/db/schema";
import type { Field, FormDefinition, FormScoring } from "@beam/core/forms";
import { formatDate, formatNumber, t, type Locale, type LocalizedText } from "@beam/core/i18n";

/** One submission as the export reads it (no sensitive value, no IP hash, no token). */
export type SubmissionExportRow = {
  id: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  version: number;
  locale: string;
  personEmail: string | null;
  personFirstName: string | null;
  personLastName: string | null;
  outcomeKey: string | null;
  total: number | null;
  source: string;
  campaign: string | null;
  funnel: string;
  utm: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
  landingPath: string | null;
  linkName: string | null;
  enteredByStaff: boolean;
  answers: Record<string, unknown>;
};

type VersionLike = Pick<FormVersionRow, "definition" | "scoring" | "sensitiveFieldKeys">;

const FORMULA_START = /^[=+\-@\t\r]/;

/** Any value as text: primitives as is, dates as ISO, objects and arrays as JSON. */
function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? "";
}

/** One CSV cell: injection guard for text, then quoted with doubled quotes. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let s = str(value);
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Header and rows as CSV text (CRLF line ends, UTF-8 BOM so spreadsheet apps read accents). */
export function toCsvText(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

const text = (v: LocalizedText | undefined, locale: Locale): string | null => (v ? (v[locale] ?? null) : null);

/** `YYYY-MM-DD HH:mm` in Brussels (export timestamps). */
export function brusselsStamp(d: Date | null): string | null {
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return parts.replace(",", "");
}

/**
 * An answer as text in `locale`: option labels instead of keys, yes and no, numbers and dates
 * (`display` formats them with `Intl`, `csv` keeps them machine-readable).
 */
export function answerText(field: Field, value: unknown, locale: Locale, mode: "display" | "csv" = "display"): string | null {
  if (value === null || value === undefined || value === "") return null;
  const yes = () => t(locale, "forms.public.yes");
  const no = () => t(locale, "forms.public.no");
  switch (field.type) {
    case "single_choice":
    case "dropdown": {
      const o = field.options.find((x) => x.key === value);
      return o ? (text(o.label, locale) ?? o.key) : str(value);
    }
    case "multiple_choice": {
      const list = Array.isArray(value) ? value : [value];
      return list.map((k) => {
        const o = field.options.find((x) => x.key === k);
        return o ? (text(o.label, locale) ?? o.key) : str(k);
      }).join("; ");
    }
    case "yes_no":
    case "consent":
    case "acknowledgement":
      return value === true || value === "yes" ? yes() : value === false || value === "no" ? no() : str(value);
    case "rating":
    case "number":
      return typeof value === "number" ? (mode === "display" ? formatNumber(value, locale) : String(value)) : str(value);
    case "date":
      return mode === "display" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value, locale) : str(value);
    default:
      return str(value);
  }
}

/** The fields of a definition in section order (fields in no section last), sensitive ones removed. */
export function exportFields(def: FormDefinition, sensitiveKeys: readonly string[]): Field[] {
  const skip = new Set(sensitiveKeys);
  const ordered: string[] = [];
  for (const s of def.sections) for (const k of s.fieldKeys) if (!ordered.includes(k)) ordered.push(k);
  for (const k of Object.keys(def.fields)) if (!ordered.includes(k)) ordered.push(k);
  return ordered.map((k) => def.fields[k]).filter((f): f is Field => !!f && !f.sensitive && !skip.has(f.key));
}

const FIXED = [
  "submission_id",
  "status",
  "started_at",
  "completed_at",
  "version",
  "locale",
  "email",
  "first_name",
  "last_name",
  "outcome",
  "total",
  "source",
  "campaign",
  "funnel",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "landing_path",
  "link",
  "entered_by_staff",
] as const;

/**
 * `toSubmissionCsv(rows, version, locale)`: the CSV of the submissions list. Column titles and
 * labels come from `version` (the version the export was asked for, by default the current one);
 * answers of rows on other versions are matched by field key. Never a sensitive column (SE4).
 */
export function toSubmissionCsv(rows: SubmissionExportRow[], version: VersionLike, locale: Locale): string {
  const def = version.definition as unknown as FormDefinition;
  const scoring = (version.scoring ?? {}) as unknown as Partial<FormScoring>;
  const fields = exportFields(def, version.sensitiveFieldKeys ?? []);
  const header = [
    ...FIXED.map((k) => t(locale, `forms.submissions.csv.${k}`)),
    ...fields.map((f) => `${text(f.label, locale) ?? f.key} (${f.key})`),
  ];
  const outcomeLabel = (key: string | null): string | null => {
    if (!key) return null;
    const o = (scoring.outcomes ?? []).find((x) => x.key === key);
    return o ? (text(o.label, locale) ?? key) : key;
  };
  const body = rows.map((r) => [
    r.id,
    t(locale, `forms.submissions.status_${r.status}`),
    brusselsStamp(r.startedAt),
    brusselsStamp(r.completedAt),
    r.version,
    r.locale,
    r.personEmail,
    r.personFirstName,
    r.personLastName,
    outcomeLabel(r.outcomeKey),
    r.total,
    r.source,
    r.campaign,
    r.funnel,
    r.utm.source ?? null,
    r.utm.medium ?? null,
    r.utm.campaign ?? null,
    r.utm.term ?? null,
    r.utm.content ?? null,
    r.landingPath,
    r.linkName,
    r.enteredByStaff ? t(locale, "forms.public.yes") : t(locale, "forms.public.no"),
    ...fields.map((f) => answerText(f, r.answers[f.key], locale, "csv")),
  ]);
  return toCsvText(header, body);
}

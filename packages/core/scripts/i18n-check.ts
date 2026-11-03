/**
 * `pnpm i18n:check` (PL-62, platform spec section 8).
 *
 * `en` is the source catalogue. Fails when `nl-BE` or `fr-BE` lacks a key that `en` has,
 * has an extra key, or has an empty value; when a key does not start with its file's module
 * name; and when a message is not valid ICU. Run with `--dir <path>` to check another tree
 * (the tests use fixtures).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";

export const CHECK_LOCALES = ["en", "nl-BE", "fr-BE"] as const;
const SOURCE = "en";

export type I18nProblemKind = "missing_key" | "extra_key" | "empty_value" | "wrong_prefix" | "icu_syntax" | "invalid_json" | "not_a_string";

export type I18nProblem = { kind: I18nProblemKind; locale: string; file: string; key: string; detail?: string };

type Tree = { [key: string]: unknown };

function readJson(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Flattens a nested catalogue into `dotted.key -> leaf`. */
function flatten(node: unknown, prefix: string, out: Map<string, unknown>): void {
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Tree)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.set(prefix, node);
}

function listJson(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/** Checks the catalogue tree at `dir` (`<dir>/<locale>/<module>.json`). Returns every problem found. */
export function checkCatalogues(dir: string): I18nProblem[] {
  const problems: I18nProblem[] = [];
  const files = new Set<string>();
  for (const locale of CHECK_LOCALES) for (const f of listJson(path.join(dir, locale))) files.add(f);

  for (const file of [...files].sort()) {
    const module = file.replace(/\.json$/, "");
    const flat = new Map<string, Map<string, unknown>>();
    for (const locale of CHECK_LOCALES) {
      const full = path.join(dir, locale, file);
      const map = new Map<string, unknown>();
      flat.set(locale, map);
      if (!fs.existsSync(full)) continue;
      const parsed = readJson(full);
      if (!parsed.ok) {
        problems.push({ kind: "invalid_json", locale, file, key: "", detail: parsed.error });
        continue;
      }
      flatten(parsed.value, "", map);
      map.delete("");
    }

    for (const locale of CHECK_LOCALES) {
      const map = flat.get(locale) ?? new Map<string, unknown>();
      for (const [key, value] of map) {
        if (key !== module && !key.startsWith(`${module}.`)) {
          problems.push({ kind: "wrong_prefix", locale, file, key, detail: `keys in ${file} must start with "${module}."` });
        }
        if (typeof value !== "string") {
          problems.push({ kind: "not_a_string", locale, file, key });
          continue;
        }
        if (value.trim() === "") {
          problems.push({ kind: "empty_value", locale, file, key });
          continue;
        }
        try {
          new IntlMessageFormat(value, locale, undefined, { ignoreTag: true });
        } catch (error) {
          problems.push({ kind: "icu_syntax", locale, file, key, detail: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    const source = flat.get(SOURCE) ?? new Map<string, unknown>();
    for (const locale of CHECK_LOCALES) {
      if (locale === SOURCE) continue;
      const map = flat.get(locale) ?? new Map<string, unknown>();
      for (const key of source.keys()) if (!map.has(key)) problems.push({ kind: "missing_key", locale, file, key });
      for (const key of map.keys()) if (!source.has(key)) problems.push({ kind: "extra_key", locale, file, key });
    }
  }
  return problems;
}

export function formatProblem(p: I18nProblem): string {
  const where = `${p.locale}/${p.file}`;
  return `${where}: ${p.kind}${p.key ? ` ${p.key}` : ""}${p.detail ? ` (${p.detail})` : ""}`;
}

export const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/i18n/messages");

function main(argv: string[]): number {
  const at = argv.indexOf("--dir");
  const given = at >= 0 ? argv[at + 1] : undefined;
  const dir = given ? path.resolve(given) : DEFAULT_DIR;
  const problems = checkCatalogues(dir);
  if (problems.length) {
    for (const p of problems) console.error(formatProblem(p));
    console.error(`i18n:check: ${problems.length} problem(s) in ${dir}`);
    return 1;
  }
  console.log(`i18n:check: catalogues complete (${dir})`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

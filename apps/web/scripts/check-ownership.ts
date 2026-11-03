/**
 * Ownership check for a package branch (CI and humans; the build session uses
 * scripts/build/ownership.mjs with the same rules).
 *
 *   tsx apps/web/scripts/check-ownership.ts --package <id> --base <sha> [--head <ref>]
 *
 * Lists `git diff --name-only <base>...<head>`, matches each path against the package's
 * globs in docs/build/ownership.json and exits 1 listing every foreign path. Always
 * allowed: generated files, `docs/build/dependency-requests/<id>.md`, and BS-23 test
 * files (name starting with the package id in lower case, inside an owned folder).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GLOB_CHARS = /[*?{]/;

/** Escapes `[` and `]` of route folder names (`[locale]`) so they match literally. */
const escapeBrackets = (s: string) => s.replace(/[[\]]/g, (c) => (c === "[" ? "[[]" : "[]]"));

/** Normalises an owns entry: no spaces inside braces, a trailing `/` means the whole folder. */
export function normaliseEntry(entry: string): string {
  let s = entry.trim().replace(/\{([^}]*)\}/g, (_, inner: string) => `{${inner.split(",").map((x) => x.trim()).join(",")}}`);
  if (s.endsWith("/")) s += "**";
  return s;
}

/** True when the owns entry covers the repository path. */
export function covers(entry: string, file: string): boolean {
  const e = normaliseEntry(entry);
  if (!GLOB_CHARS.test(e)) return e === file;
  return path.posix.matchesGlob(file, escapeBrackets(e));
}

function staticDir(entry: string): string {
  const e = normaliseEntry(entry);
  if (!GLOB_CHARS.test(e)) return path.posix.dirname(e);
  return e.slice(0, e.search(GLOB_CHARS)).replace(/\/[^/]*$/, "");
}

/** Paths every package may change. */
export function alwaysAllowed(id: string, file: string): boolean {
  return (
    file.endsWith(".generated.ts") ||
    file === "packages/db/src/schema/index.ts" ||
    file === `docs/build/dependency-requests/${id}.md`
  );
}

/** BS-23: a test file named after the package (or a fixture folder named after it) inside an owned folder. */
export function bs23Allowed(id: string, owns: string[], file: string): boolean {
  const lower = id.toLowerCase();
  const base = path.posix.basename(file);
  const inFixtureDir = file.split("/").includes(lower);
  if (!base.startsWith(lower) && !inFixtureDir) return false;
  const dir = path.posix.dirname(file);
  return owns.some((e) => {
    const d = staticDir(e);
    return dir === d || dir.startsWith(`${d}/`);
  });
}

/** The changed paths the package does not own. */
export function foreignPaths(id: string, owns: string[], files: string[]): string[] {
  return files.filter(
    (f) => !alwaysAllowed(id, f) && !owns.some((e) => covers(e, f)) && !bs23Allowed(id, owns, f),
  );
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[], root: string): number {
  const id = arg(argv, "--package");
  const base = arg(argv, "--base");
  const head = arg(argv, "--head") ?? "HEAD";
  if (!id || !base) {
    console.error("usage: check-ownership.ts --package <id> --base <sha> [--head <ref>]");
    return 2;
  }
  const ownershipFile = path.join(root, "docs/build/ownership.json");
  const ownership = JSON.parse(fs.readFileSync(ownershipFile, "utf8")) as Record<string, { owns?: string[] }>;
  const owns = ownership[id]?.owns;
  if (!owns) {
    console.error(`check-ownership: unknown package ${id} (not in docs/build/ownership.json)`);
    return 2;
  }
  const diff = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { cwd: root, encoding: "utf8" });
  const files = diff.split("\n").filter(Boolean);
  const foreign = foreignPaths(id, owns, files);
  if (foreign.length) {
    console.error(`check-ownership: ${id} changed ${foreign.length} path(s) it does not own:`);
    for (const f of foreign) console.error(`  ${f}`);
    return 1;
  }
  console.log(`check-ownership: ${id} ok (${files.length} changed paths)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  process.exitCode = main(process.argv.slice(2), root);
}

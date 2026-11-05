/**
 * Route seam helpers (platform-P12, PL-95, gap G11): map a URL to the file under `apps/web/app/`
 * that Next.js would render for it, by reading the folder tree from disk. A page that exists only
 * on paper, or sits outside the router (for example under `apps/web/modules/`), fails here at the
 * unit-test gate instead of late at an e2e checkpoint.
 *
 * Matching follows the App Router:
 * - route groups `(x)` add no segment; private folders `_x`, parallel slots `@x` and intercepting
 *   folders `(.)x` are not routes;
 * - a static segment wins over `[param]`, which wins over `[...param]`, which wins over
 *   `[[...param]]`; a branch that matches no leaf falls back to the next candidate;
 * - `[locale]` matches only `nl`, `fr` and `en` (the URL segments of `nl-BE`, `fr-BE`, `en`);
 * - a leaf is a `page.*` file or a `route.*` handler in the folder the last segment reaches.
 *
 * Used by `routes-v1.test.ts` (platform-P12), `routes-r2.test.ts` (platform-P13) and
 * `routes-r3.test.ts` (platform-P14).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/web/app`, resolved from this file. */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app");

/** The values `[locale]` accepts: the URL segments of the three locales. */
export const LOCALE_SEGMENTS = ["nl", "fr", "en"] as const;

const PAGE_FILES = ["page.tsx", "page.ts", "page.jsx", "page.js", "page.mdx"];
const ROUTE_FILES = ["route.ts", "route.js"];

export type ResolvedRoute = { file: string; params: Record<string, string> };

export type RequiredRoute = {
  url: string;
  /** The package that owns the page (named in the failure message). */
  owner: string;
  /** Files that must sit in the page's own folder beside it. */
  needs?: ("loading" | "error")[];
};

type Entry = { name: string; dir: string };

function subdirs(dir: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      try {
        return statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({ name, dir: path.join(dir, name) }));
}

const isGroup = (name: string) => /^\([^.)][^)]*\)$/.test(name);
const isHidden = (name: string) => name.startsWith("_") || name.startsWith("@") || name.startsWith("(.") || name === "node_modules";
const optionalCatchAll = (name: string) => /^\[\[\.\.\.([^\]]+)\]\]$/.exec(name)?.[1];
const catchAll = (name: string) => /^\[\.\.\.([^\]]+)\]$/.exec(name)?.[1];
const dynamic = (name: string) => /^\[([^.\]][^\]]*)\]$/.exec(name)?.[1];

/** Folders reachable from `dir` without consuming a URL segment (route groups, recursively). */
function expandGroups(dir: string): string[] {
  const out = [dir];
  for (const child of subdirs(dir)) if (isGroup(child.name)) out.push(...expandGroups(child.dir));
  return out;
}

function leafIn(dir: string): string | null {
  for (const f of [...PAGE_FILES, ...ROUTE_FILES]) {
    const file = path.join(dir, f);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Normalises a URL or path to its decoded path segments (query and hash dropped). */
export function urlSegments(url: string): string[] {
  const pathname = /^[a-z]+:\/\//i.test(url) ? new URL(url).pathname : (url.split(/[?#]/)[0] ?? "");
  return pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

function match(dirs: string[], segs: string[], params: Record<string, string>): ResolvedRoute | null {
  // Every folder reachable through route groups counts as "here".
  const here = dirs.flatMap(expandGroups);
  if (segs.length === 0) {
    for (const dir of here) {
      const leaf = leafIn(dir);
      if (leaf) return { file: leaf, params };
    }
    // An optional catch-all matches zero segments.
    for (const dir of here) {
      for (const child of subdirs(dir)) {
        const name = optionalCatchAll(child.name);
        if (!name) continue;
        const leaf = leafIn(child.dir);
        if (leaf) return { file: leaf, params };
      }
    }
    return null;
  }
  const [seg, ...rest] = segs as [string, ...string[]];
  const children = here.flatMap(subdirs).filter((c) => !isGroup(c.name) && !isHidden(c.name));
  // 1. static
  const statics = children.filter((c) => c.name === seg);
  const viaStatic = match(
    statics.map((c) => c.dir),
    rest,
    params,
  );
  if (viaStatic) return viaStatic;
  // 2. dynamic (one segment each, tried in folder-name order)
  for (const child of children) {
    const name = dynamic(child.name);
    if (!name) continue;
    if (name === "locale" && !(LOCALE_SEGMENTS as readonly string[]).includes(seg)) continue;
    const found = match([child.dir], rest, { ...params, [name]: seg });
    if (found) return found;
  }
  // 3. catch-all, then 4. optional catch-all: the rest of the path, a leaf right in that folder.
  for (const pick of [catchAll, optionalCatchAll]) {
    for (const child of children) {
      const name = pick(child.name);
      if (!name) continue;
      const leaf = leafIn(child.dir);
      if (leaf) return { file: leaf, params: { ...params, [name]: segs.join("/") } };
    }
  }
  return null;
}

/**
 * The file under `appDir` (default `apps/web/app`) that serves `url`, with the matched params
 * (`[...x]` and `[[...x]]` give the rest of the path joined by `/`), or `null` when no page or
 * route handler would answer.
 */
export function resolveRoute(url: string, appDir: string = APP_DIR): { file: string; params: Record<string, string> } | null {
  if (!existsSync(appDir)) return null;
  return match([appDir], urlSegments(url), {});
}

/** Path relative to `apps/web` (or to the fixture's parent), with forward slashes. */
export function relativeFile(file: string, appDir: string = APP_DIR): string {
  return path.relative(path.dirname(appDir), file).split(path.sep).join("/");
}

/** Problems for each required route: no page, a route handler instead of a page, a missing loading or error file. */
export function checkRoutes(routes: readonly RequiredRoute[], appDir: string = APP_DIR): string[] {
  const problems: string[] = [];
  for (const route of routes) {
    const found = resolveRoute(route.url, appDir);
    if (!found) {
      problems.push(`no page for ${route.url} (owner ${route.owner})`);
      continue;
    }
    if (!/^page\./.test(path.basename(found.file))) {
      problems.push(`${route.url} resolves to ${relativeFile(found.file, appDir)}, not a page (owner ${route.owner})`);
      continue;
    }
    const folder = path.dirname(found.file);
    for (const need of route.needs ?? []) {
      const ok = [".tsx", ".ts", ".jsx", ".js"].some((ext) => existsSync(path.join(folder, `${need}${ext}`)));
      if (!ok) problems.push(`${route.url}: no ${need}.tsx beside ${relativeFile(found.file, appDir)} (owner ${route.owner})`);
    }
  }
  return problems;
}

/** Throws one error listing every required route that has no page (or misses its loading/error file). */
export function assertRoutes(routes: RequiredRoute[], appDir: string = APP_DIR): void {
  const problems = checkRoutes(routes, appDir);
  if (problems.length > 0) throw new Error(`Route seam failures:\n- ${problems.join("\n- ")}`);
}

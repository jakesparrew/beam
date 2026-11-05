/**
 * Handbook link checker (platform-P11a, PL-91, blueprint 80).
 *
 * 1. Every relative markdown link in `docs/handbook/` (also `training/`, which platform-P11b
 *    writes) resolves to a file or folder, and every `#anchor` matches a heading or an explicit
 *    `<a id="...">` in the target page.
 * 2. Every blueprint 80 topic has its page, the page has a title, and `README.md` links to it.
 * 3. Every runbook a page names (`docs/runbooks/<name>.md`, linked or in code) exists.
 *
 * `data-model.generated.md` is written by `pnpm docs:schema` (PL-91) and committed by the
 * orchestrator after each migration; a link to it is accepted while the file is absent in a
 * package branch, as long as the generator still writes to that path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HANDBOOK = path.join(ROOT, "docs/handbook");
const RUNBOOKS = path.join(ROOT, "docs/runbooks");
const GENERATED_PAGES = ["data-model.generated.md"] as const;
const GENERATOR = path.join(ROOT, "packages/db/scripts/docs-schema.ts");

/** Blueprint 80 topics and the page that covers each (platform spec, platform-P11 table). */
export const BLUEPRINT_80_PAGES: Readonly<Record<string, string>> = {
  Architecture: "architecture.md",
  Database: "database.md",
  Integrations: "integrations.md",
  "User roles": "roles.md",
  "Business rules": "business-rules.md",
  Automations: "automations.md",
  "AI connections": "ai-connections.md",
  Hosting: "hosting.md",
  Backup: "backup.md",
  Support: "support.md",
  Deployment: "deployment.md",
  "Data model": "database.md",
  "Core workflows": "core-workflows.md",
};

/** Pages of the handbook beyond the blueprint topics (blueprints 68 to 70, PL-92). */
const OTHER_PAGES = ["README.md", "ownership-and-exit.md"] as const;

export type Link = { target: string; line: number };

/** Removes fenced code blocks and inline code, keeping line numbers. */
export function stripCode(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      if (inFence) return "";
      return line.replace(/`[^`]*`/g, "");
    })
    .join("\n");
}

/** Markdown links `[text](target)` and `<a href="target">` outside code. */
export function extractLinks(markdown: string): Link[] {
  const out: Link[] = [];
  stripCode(markdown)
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1]!, line: i + 1 });
      for (const m of line.matchAll(/<a\s[^>]*href="([^"]+)"/g)) out.push({ target: m[1]!, line: i + 1 });
    });
  return out;
}

/** GitHub's heading slug: lower case, punctuation removed, spaces to hyphens. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor a page offers: heading slugs (with GitHub's -1, -2 suffixes) and explicit ids. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of markdown.matchAll(/<a\s[^>]*(?:id|name)="([^"]+)"/g)) anchors.add(m[1]!);
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = slugify(h[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

const isExternal = (t: string) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//");

/** Problems of one page: links whose file or anchor does not exist. */
export function checkPage(file: string, markdown: string, exists: (p: string) => boolean, read: (p: string) => string | null): string[] {
  const problems: string[] = [];
  for (const { target, line } of extractLinks(markdown)) {
    if (isExternal(target)) continue;
    const [rawPath, anchor] = target.split("#", 2) as [string, string | undefined];
    const where = `${path.relative(ROOT, file)}:${line} -> ${target}`;
    const resolved = rawPath === "" ? file : path.resolve(path.dirname(file), decodeURIComponent(rawPath));
    const generated = GENERATED_PAGES.some((g) => resolved === path.join(HANDBOOK, g));
    if (!exists(resolved)) {
      if (!generated) problems.push(`${where}: file not found`);
      continue;
    }
    if (anchor && resolved.endsWith(".md")) {
      const body = read(resolved);
      if (body !== null && !anchorsOf(body).has(anchor)) problems.push(`${where}: anchor not found`);
    }
  }
  return problems;
}

/** Runbook names a page mentions as `runbooks/<name>.md`, linked or in code. */
export function runbooksNamed(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/runbooks\/([a-z0-9][a-z0-9-]*\.md)/g)].map((m) => m[1]!))];
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".md") ? [p] : [];
  });
}

const exists = (p: string) => fs.existsSync(p);
const read = (p: string) => (fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : null);
const pages = walk(HANDBOOK);

describe("handbook link checker (helpers)", () => {
  it("finds a broken file link and a broken anchor, and ignores code and external links", () => {
    const md = [
      "# Title",
      "## Good heading",
      "[ok](#good-heading) [bad](#missing) [web](https://example.com) [mail](mailto:a@example.com)",
      "`[in code](nowhere.md)`",
      "```",
      "[in fence](nowhere.md)",
      "```",
      "[gone](does-not-exist.md)",
    ].join("\n");
    const file = path.join(HANDBOOK, "sample.md");
    const problems = checkPage(file, md, (p) => p === file, () => md);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes("#missing") && p.endsWith("anchor not found"))).toBe(true);
    expect(problems.some((p) => p.includes("does-not-exist.md") && p.endsWith("file not found"))).toBe(true);
  });

  it("slugs headings like GitHub, with suffixes for repeats and explicit ids", () => {
    const anchors = anchorsOf("# A. Neon point-in-time restore (within 7 days)\n## Steps\n## Steps\n<a id=\"locations\"></a>");
    expect(anchors.has("a-neon-point-in-time-restore-within-7-days")).toBe(true);
    expect(anchors.has("steps")).toBe(true);
    expect(anchors.has("steps-1")).toBe(true);
    expect(anchors.has("locations")).toBe(true);
  });

  it("collects runbook names from links and code", () => {
    expect(runbooksNamed("see [x](../runbooks/restore.md) and `docs/runbooks/dead-jobs.md`, again ../runbooks/restore.md").sort()).toEqual(["dead-jobs.md", "restore.md"]);
  });
});

describe("docs/handbook", () => {
  it("has pages", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it("every relative link and anchor resolves", () => {
    const problems = pages.flatMap((file) => checkPage(file, fs.readFileSync(file, "utf8"), exists, read));
    expect(problems).toEqual([]);
  });

  it("every blueprint 80 topic has a page with a title, linked from README.md", () => {
    const readme = fs.readFileSync(path.join(HANDBOOK, "README.md"), "utf8");
    const linked = new Set(extractLinks(readme).map((l) => l.target.split("#")[0]));
    const missing: string[] = [];
    for (const [topic, page] of Object.entries(BLUEPRINT_80_PAGES)) {
      const file = path.join(HANDBOOK, page);
      if (!fs.existsSync(file)) missing.push(`${topic}: ${page} missing`);
      else if (!/^# \S/m.test(fs.readFileSync(file, "utf8"))) missing.push(`${topic}: ${page} has no title`);
      if (!linked.has(page)) missing.push(`${topic}: README.md does not link ${page}`);
    }
    for (const page of OTHER_PAGES) if (!fs.existsSync(path.join(HANDBOOK, page))) missing.push(`${page} missing`);
    expect(missing).toEqual([]);
  });

  it("the data model topic points at the generated page, which pnpm docs:schema writes", () => {
    const database = fs.readFileSync(path.join(HANDBOOK, "database.md"), "utf8");
    expect(extractLinks(database).some((l) => l.target.startsWith("data-model.generated.md"))).toBe(true);
    expect(fs.readFileSync(GENERATOR, "utf8")).toContain('"../../docs/handbook/data-model.generated.md"');
  });

  it("every runbook a page names exists", () => {
    const missing = pages.flatMap((file) =>
      runbooksNamed(fs.readFileSync(file, "utf8"))
        .filter((name) => !fs.existsSync(path.join(RUNBOOKS, name)))
        .map((name) => `${path.relative(ROOT, file)} names docs/runbooks/${name}`),
    );
    expect(missing).toEqual([]);
  });
});

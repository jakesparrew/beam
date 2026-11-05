/**
 * platform-P11b: the training guides (blueprint 79) and `training-screenshots.ts` stay in step.
 * Every guide exists and is task-based, the README maps every guide, every image a guide shows is
 * a shot the script captures (and exists), every shot is shown by its guide, every relative link
 * resolves, and every shot opens a route that exists in the app.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDES, IMG_DIR, parseArgs, placeholderPng, SHOTS, TRAINING_DIR, writePlaceholders } from "./training-screenshots";

const APP_DIR = path.resolve(import.meta.dirname, "../app");
const read = (file: string) => readFileSync(path.join(TRAINING_DIR, file), "utf8");
const pages = ["README.md", ...GUIDES.map((g) => `${g}.md`)];

/** Markdown links and images outside fenced code: `[text](target)`. */
function links(markdown: string): { image: boolean; target: string }[] {
  const out: { image: boolean; target: string }[] = [];
  const text = markdown.replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)) out.push({ image: m[1] === "!", target: m[2]! });
  return out;
}

/** Whether a URL path is served by a `page.tsx` under the app's route folders. */
function routeExists(urlPath: string): boolean {
  const clean = urlPath.split("?")[0]!.replace(/^\/|\/$/g, "");
  const segments = clean ? clean.split("/") : [];
  const walk = (dir: string, rest: string[]): boolean => {
    if (!existsSync(dir)) return false;
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    // Route groups `(name)` add no URL segment.
    for (const group of entries.filter((e) => /^\(.+\)$/.test(e.name))) if (walk(path.join(dir, group.name), rest)) return true;
    if (!rest.length) return existsSync(path.join(dir, "page.tsx"));
    const [head, ...tail] = rest;
    if (entries.some((e) => e.name === head) && walk(path.join(dir, head!), tail)) return true;
    return entries.filter((e) => /^\[[^.\]]+\]$/.test(e.name)).some((e) => walk(path.join(dir, e.name), tail));
  };
  return walk(APP_DIR, segments);
}

describe("training guides", () => {
  it("has the README and one page per blueprint 79 topic, each task-based", () => {
    expect(GUIDES).toHaveLength(9);
    for (const page of pages) {
      expect(existsSync(path.join(TRAINING_DIR, page)), page).toBe(true);
      if (page !== "README.md") expect(read(page).match(/^## How do I /gm)?.length ?? 0, page).toBeGreaterThanOrEqual(2);
    }
  });

  it("maps every guide to roles in the README and names the week-7 people", () => {
    const readme = read("README.md");
    for (const g of GUIDES) expect(readme, g).toContain(`](${g}.md)`);
    for (const role of ["reception", "customer_service", "marketing", "management", "finance", "owner", "technical_admin"]) expect(readme).toContain(`| ${role} (`);
    for (const name of ["Jonathan", "Tinne", "George", "Tet"]) expect(readme).toContain(name);
  });

  it("resolves every relative link and image", () => {
    for (const page of pages) {
      for (const { target } of links(read(page))) {
        if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
        const file = target.split("#")[0]!;
        expect(existsSync(path.resolve(TRAINING_DIR, file)), `${page} -> ${target}`).toBe(true);
      }
    }
  });

  it("shows only images the script captures, and every shot in its own guide", () => {
    const files = new Set(SHOTS.map((s) => s.file));
    expect(files.size).toBe(SHOTS.length);
    for (const page of pages) {
      for (const { target } of links(read(page)).filter((l) => l.image)) {
        expect(target.startsWith("img/"), `${page}: ${target}`).toBe(true);
        expect(files.has(target.slice(4)), `${page}: ${target} is not in SHOTS`).toBe(true);
      }
    }
    for (const shot of SHOTS) {
      expect(read(`${shot.guide}.md`), shot.file).toContain(`(img/${shot.file})`);
      expect(shot.file.startsWith(`${shot.guide}-`), shot.file).toBe(true);
      const png = readFileSync(path.join(IMG_DIR, shot.file));
      expect(png.subarray(1, 4).toString("ascii"), shot.file).toBe("PNG");
    }
  });

  it("captures routes that exist in the app", () => {
    for (const shot of SHOTS) expect(routeExists(shot.path), `${shot.file}: ${shot.path}`).toBe(true);
    expect(routeExists("/admin/does-not-exist")).toBe(false);
  });
});

describe("training-screenshots.ts", () => {
  it("writes a valid PNG placeholder only where an image is missing", async () => {
    const png = placeholderPng(40, 30);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(40);
    expect(png.readUInt32BE(20)).toBe(30);
    const dir = await mkdtemp(path.join(tmpdir(), "training-img-"));
    try {
      const shots = SHOTS.slice(0, 2);
      expect(await writePlaceholders(dir, shots)).toEqual(shots.map((s) => s.file));
      expect(await writePlaceholders(dir, shots)).toEqual([]);
      expect((await readFile(path.join(dir, shots[0]!.file))).subarray(1, 4).toString("ascii")).toBe("PNG");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses its arguments", () => {
    expect(parseArgs([])).toEqual({ only: null, placeholders: false });
    expect(parseArgs(["--only", "booking", "--placeholders"])).toEqual({ only: "booking", placeholders: true });
    expect(() => parseArgs(["--only", "nope"])).toThrow(/usage/);
  });
});

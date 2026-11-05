import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GenIndexesError, generate, HEADER, OUTPUTS, writeOutputs } from "./gen-indexes";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/gen");
const tree = (name: string) => path.join(fixtures, name);

function problemsOf(name: string): string[] {
  try {
    generate(tree(name));
  } catch (error) {
    if (error instanceof GenIndexesError) return error.problems;
    throw error;
  }
  throw new Error(`expected ${name} to fail`);
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function copyTree(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-indexes-"));
  temps.push(dir);
  fs.cpSync(tree(name), dir, { recursive: true });
  return dir;
}

describe("gen-indexes", () => {
  it("(1) produces sorted, byte-identical output on two runs", () => {
    const first = generate(tree("two-modules"));
    const second = generate(tree("two-modules"));
    expect(second).toEqual(first);
    for (const content of Object.values(first)) {
      expect(content.startsWith(HEADER)).toBe(true);
      expect(content).not.toContain("\r");
    }

    const jobs = first[OUTPUTS.jobs]!;
    const order = ["crm.add_suppression", "crm.merge_persons", "crm.sync_person", "webinar.schedule_reminders"];
    const positions = order.map((k) => jobs.indexOf(`"${k}"`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(jobs.indexOf('from "../modules/crm/jobs"')).toBeLessThan(jobs.indexOf('from "../modules/webinar/jobs"'));
    // Entries point at the array element of the facade, including a same-file const.
    expect(jobs).toContain('"crm.sync_person": crm_jobs[1]!');

    const types = first[OUTPUTS.types]!;
    expect(types).toContain('export type ModuleId =\n  | "crm"\n  | "webinar";');
    expect(types).toContain('| "persons.merge"');
    expect(first[OUTPUTS.permissions]).toContain('"persons.merge",\n  "persons.read",\n  "persons.write",\n  "webinars.host",');
    expect(first[OUTPUTS.webhooks]).toContain('"meta": crm_webhookHandlers[0]!');
    expect(first[OUTPUTS.settings]).toContain('"crm_rules": { ...crm_settings[0]!, owner: "crm" }');
    expect(first[OUTPUTS.privacy]).toContain('export const NO_PII_TABLES = ["segments", "tags"] as const;');

    // Demo seeds in dependency order: webinar before crm (crm runs after webinar).
    const seeds = first[OUTPUTS.seeds]!;
    expect(seeds.indexOf('module: "webinar"')).toBeLessThan(seeds.indexOf('module: "crm"'));
    const dbSeeds = first[OUTPUTS.dbSeeds]!;
    expect(dbSeeds.indexOf('module: "platform"')).toBeLessThan(dbSeeds.indexOf('module: "crm"'));
    expect(dbSeeds).not.toContain("run.ts");
    expect(dbSeeds).not.toContain('"./run"');

    const messages = first[OUTPUTS.messages]!;
    expect(messages).toContain('import en_crm from "./en/crm.json" with { type: "json" };');
    expect(messages).toContain('export const MESSAGE_LOCALES = ["en", "nl-BE"] as const;');

    // Writing twice gives the same bytes, and the second run rewrites nothing.
    const dir = copyTree("two-modules");
    expect(writeOutputs(dir, generate(dir)).length).toBe(Object.keys(first).length);
    const bytes = fs.readFileSync(path.join(dir, OUTPUTS.jobs));
    expect(writeOutputs(dir, generate(dir))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, OUTPUTS.jobs)).equals(bytes)).toBe(true);
  });

  it("(2) fails on a job kind declared in two modules, naming both files", () => {
    const problems = problemsOf("dup-job");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('duplicate job "shared.run_thing"');
    expect(problems[0]).toContain("apps/web/modules/booking/jobs.ts:1");
    expect(problems[0]).toContain("apps/web/modules/crm/jobs.ts:1");
  });

  it("(2b) fails on a non-literal key with file and line, and writes nothing", () => {
    const dir = copyTree("non-literal");
    expect(() => generate(dir)).toThrow(GenIndexesError);
    expect(problemsOf("non-literal")[0]).toMatch(
      /^apps\/web\/modules\/crm\/jobs\.ts:2: registry values must be string literals/,
    );
    expect(fs.existsSync(path.join(dir, OUTPUTS.jobs))).toBe(false);
  });

  it("(3) skips a module without nav.ts", () => {
    const out = generate(tree("two-modules"));
    const nav = out[OUTPUTS.nav]!;
    expect(nav).toContain('import { nav as crm_nav } from "../modules/crm/nav";');
    expect(nav).not.toContain("webinar");
    expect(nav).toContain("admin: [\n    crm_nav[0]!,\n  ],");
    expect(nav).toContain("portal: [\n    crm_nav[1]!,\n  ],");
  });

  it("(4) includes <m>.views.ts in the schema index only when it exists", () => {
    const schema = generate(tree("two-modules"))[OUTPUTS.schema]!;
    expect(schema).toBe(
      `${HEADER}\n\nexport * from "./crm";\nexport * from "./crm.views";\nexport * from "./webinar";\n`,
    );
    expect(schema).not.toContain("_shared");
  });

  it("(5) keys templates <folder>.<name> and rejects duplicates, mismatched files and slashes", () => {
    const registry = generate(tree("two-modules"))[OUTPUTS.templates]!;
    expect(registry).toContain('import { templates as platform_templates } from "./platform/index";');
    expect(registry).toContain('"platform.magic_link": platform_templates[1]!');
    expect(registry).toContain('"platform.staff_invite": platform_templates[0]!');
    expect(generate(tree("two-modules"))[OUTPUTS.types]).toContain('| "platform.magic_link"');

    expect(problemsOf("template-dup")[0]).toContain('duplicate template "platform.magic_link"');
    expect(problemsOf("template-mismatch")[0]).toContain('template name "magic_link" does not match its file "sign-in-link"');
    expect(problemsOf("template-slash")[0]).toContain('template name "platform/magic-link" must not contain a slash');
  });

  it("(6) collects merge fields keyed <m>.<field> and skips modules without merge-fields.ts", () => {
    const fields = generate(tree("two-modules"))[OUTPUTS.mergeFields]!;
    expect(fields).toContain('import { mergeFields as webinar_mergeFields } from "../modules/webinar/merge-fields";');
    expect(fields).toContain('"webinar.access_url": webinar_mergeFields["access_url"]!');
    expect(fields).toContain('"webinar.starts_at_local": webinar_mergeFields["starts_at_local"]!');
    expect(fields).toContain('"webinar.title": webinar_mergeFields["title"]!');
    expect(fields).not.toContain("crm");
  });

  it("(7) fails on a settings key declared in two modules' config.ts, naming both files", () => {
    const problems = problemsOf("dup-setting");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('duplicate setting "business_hours"');
    expect(problems[0]).toContain("apps/web/modules/booking/config.ts");
    expect(problems[0]).toContain("apps/web/modules/ops/config.ts");
  });

  it("fails on a seed dependency cycle", () => {
    expect(problemsOf("seed-cycle")[0]).toContain("demo seed order has a cycle among: booking, crm");
  });

  it("writes `export {};` and empty typed constants for an empty tree (DR-19)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-indexes-empty-"));
    temps.push(dir);
    const out = generate(dir);
    expect(Object.keys(out).sort()).toEqual(Object.values(OUTPUTS).sort());
    expect(out[OUTPUTS.jobs]).toBe(
      `${HEADER}\nexport {};\n\nexport const JOB_BY_KIND = {} as const;\nexport const JOBS = Object.values(JOB_BY_KIND);\n`,
    );
    expect(out[OUTPUTS.schema]).toBe(`${HEADER}\nexport {};\n`);
    expect(out[OUTPUTS.types]).toContain("export type JobKind = never;");
  });
});

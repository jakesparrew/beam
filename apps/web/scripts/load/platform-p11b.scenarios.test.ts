/**
 * platform-P11b: the load scenarios at smoke counts on PGlite, so the code `pnpm test:load` runs
 * against beam_dev and staging is proven before that run (the real thresholds are only measured
 * there). The tick is the real job runner with the fake integrations; scenario 1 needs a running
 * deployment and is only checked for its skip without `BASE_URL`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: () => undefined }));

import type { DbHandle } from "@beam/db";
import { campaigns, emailMessages, persons } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { createTestDb, makeUser } from "@beam/db/testing";
import { eq, setAppDb, sql } from "@/lib/ctx";
import { createFakeIntegrations, type FakeIntegrations } from "@/lib/integrations";
import { runJobs } from "@/lib/job-runner";
import { resetRuntime } from "@/lib/testing";
import { PERMISSIONS } from "@/registry/permissions.generated";
import { completeCompany } from "@/modules/email/email-p3.fixtures";
import { LOCAL_HTTPS_APP_URL, SMOKE_COUNTS, parseArgs } from "../load-test";
import { parseSections, renderPage, renderSection, runPassed, TARGETS, writeReport } from "./report";
import { SCENARIO_KEYS, bookingPaths, loadAddress, percentile, runScenarios, THRESHOLDS, type ScenarioEnv, type ScenarioResult } from "./scenarios";

let h: DbHandle;
let fakes: FakeIntegrations;

const env = (over: Partial<ScenarioEnv> = {}): ScenarioEnv => ({
  db: h.db,
  integrations: fakes,
  runId: "t3st",
  driveTick: true,
  tick: (budgetMs) => runJobs({ db: h.db, integrations: fakes, budgetMs: Math.min(budgetMs, 20_000) }),
  counts: { magicLinks: 3, drainJobs: 6, recipients: 12 },
  ...over,
});

beforeAll(async () => {
  // As load-test.ts does on a laptop: marketing mail needs an https List-Unsubscribe link.
  vi.stubEnv("APP_URL", LOCAL_HTTPS_APP_URL);
  h = await createTestDb();
  await seedDefaults(h.db, { permissions: PERMISSIONS });
  await completeCompany(h.db);
  await makeUser(h.db, { email: "load-owner@demo.beam.be", roleKey: "owner" });
  setAppDb(h.db);
  fakes = createFakeIntegrations();
}, 180_000);

afterAll(async () => {
  setAppDb(undefined);
  resetRuntime();
  vi.unstubAllEnvs();
  await h.close();
});

describe("load scenarios on PGlite (smoke counts)", () => {
  let results: ScenarioResult[];
  beforeAll(async () => {
    results = await runScenarios(env());
  }, 240_000);

  const byKey = (k: string) => results.find((r) => r.key === k)!;

  it("runs the four scenarios in order and skips the HTTP one without BASE_URL", () => {
    expect(results.map((r) => r.key)).toEqual([...SCENARIO_KEYS]);
    expect(byKey("portal_booking")).toMatchObject({ outcome: "skipped", note: "BASE_URL is not set" });
  });

  it("magic_links: every request answers and its email.send job succeeds", async () => {
    expect(byKey("magic_links")).toMatchObject({ outcome: "pass", reduced: true });
    const sent = await h.db.select({ to: emailMessages.toEmail, status: emailMessages.status }).from(emailMessages).where(sql`${emailMessages.toEmail} like 'load-t3st-ml-%'`);
    expect(sent.map((m) => m.to).sort()).toEqual([0, 1, 2].map((i) => loadAddress("t3st", "ml", i)));
    expect(sent.every((m) => m.status === "sent")).toBe(true);
  });

  it("email_drain: the queued jobs are drained", () => {
    expect(byKey("email_drain")).toMatchObject({ outcome: "pass", reduced: true });
    expect(byKey("email_drain").metrics.find((m) => m.label === "Job statuses")!.value).toBe("succeeded 6");
  });

  it("campaign_send: the campaign is planned, dispatched and sent to every recipient on the fake adapter", async () => {
    const r = byKey("campaign_send");
    expect(r.outcome, JSON.stringify(r)).toBe("pass");
    const [c] = await h.db.select().from(campaigns).where(eq(campaigns.name, "Load test t3st"));
    expect(c).toMatchObject({ status: "sent", recipientsCount: 12 });
    const audience = await h.db.select({ n: sql<number>`count(*)::int` }).from(persons).where(sql`${persons.email} like 'load-t3st-cmp-%@demo.beam.be' and ${persons.isTester}`);
    expect(Number(audience[0]!.n)).toBe(12);
  });

  it("a reduced run never counts as a pass of the proposal", () => {
    expect(runPassed(results)).toBe(false);
    const full = SCENARIO_KEYS.map((key) => ({ ...byKey(key), outcome: "pass" as const, reduced: false }));
    expect(runPassed(full)).toBe(true);
  });
});

describe("drain limits", () => {
  it("fails a scenario whose jobs do not finish within the limit", async () => {
    const r = await runScenarios(env({ runId: "sl0w", driveTick: false, pollMs: 50, limits: { email_drain: 200 }, counts: { drainJobs: 2 } }), ["email_drain"]);
    expect(r[0]).toMatchObject({ key: "email_drain", outcome: "fail" });
    expect(r[0]!.metrics.find((m) => m.label === "Drained after")!.value).toMatch(/^not within/);
  });
});

describe("helpers", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
    expect(percentile([5, 1, 3], 50)).toBe(3);
  });

  it("builds booking paths on Brussels days", () => {
    // 23:30 UTC on 31 March 2027 is already 1 April in Brussels (summer time).
    expect(bookingPaths(new Date("2027-03-31T23:30:00Z"))).toEqual([
      "/nl/account/book",
      "/nl/account/book?tab=day&day=2027-04-02",
      "/nl/account/book?tab=night&day=2027-04-03",
      "/nl/account/book?tab=event",
    ]);
  });

  it("keeps the proposal's thresholds and smoke counts below them", () => {
    expect(THRESHOLDS.portal_booking).toEqual({ connections: 100, durationSec: 60, p95Ms: 800 });
    expect(THRESHOLDS.magic_links.requests).toBe(50);
    expect(THRESHOLDS.email_drain).toEqual({ jobs: 5_000, withinMs: 900_000 });
    expect(THRESHOLDS.campaign_send).toEqual({ recipients: 20_000, withinMs: 900_000 });
    expect(SMOKE_COUNTS.recipients).toBeLessThan(THRESHOLDS.campaign_send.recipients);
  });

  it("parses the command line", () => {
    expect(parseArgs(["--target", "beam_dev"])).toEqual({ target: "beam_dev", only: [...SCENARIO_KEYS], driveTick: true, smoke: false });
    expect(parseArgs(["--target", "staging", "--only", "magic_links,email_drain", "--no-drive-tick", "--smoke"])).toEqual({ target: "staging", only: ["magic_links", "email_drain"], driveTick: false, smoke: true });
    expect(() => parseArgs(["--target", "production"])).toThrow(/usage/);
    expect(() => parseArgs(["--target", "beam_dev", "--only", "nope"])).toThrow(/usage/);
  });
});

describe("report", () => {
  const sample: ScenarioResult = {
    key: "email_drain",
    title: "5,000 queued email.send jobs drained by the tick",
    threshold: "every job succeeded within 15 minutes",
    outcome: "pass",
    reduced: false,
    metrics: [{ label: "Job statuses", value: "succeeded 5000" }],
    startedAt: "2026-11-05T09:00:00.000Z",
    durationMs: 61_000,
  };
  const meta = { target: "beam_dev" as const, ranAt: new Date("2026-11-05T09:10:00Z"), commit: "0123456789abcdef", baseUrl: "http://localhost:3000", driveTick: true };

  it("replaces only the section of the run's target", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "load-report-"));
    try {
      const file = path.join(dir, "load-test-results.md");
      await writeReport(meta, [sample], file);
      await writeReport({ ...meta, target: "staging", baseUrl: "https://staging.example.com" }, [{ ...sample, outcome: "fail" }], file);
      await writeReport({ ...meta, ranAt: new Date("2026-11-06T09:10:00Z") }, [sample], file);
      const page = await readFile(file, "utf8");
      const sections = parseSections(page);
      expect(Object.keys(sections).sort()).toEqual([...TARGETS].sort());
      expect(sections.beam_dev).toContain("Run 2026-11-06T09:10:00.000Z on commit `0123456789ab`");
      expect(sections.beam_dev).not.toContain("2026-11-05T09:10");
      expect(sections.staging).toContain("| 5,000 queued email.send jobs drained by the tick | every job succeeded within 15 minutes | FAIL | 61.0 s |");
      expect(page.match(/^# Load test results/gm)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks reduced runs and escapes table cells", () => {
    const text = renderSection(meta, [{ ...sample, reduced: true, metrics: [{ label: "a|b", value: "x\ny" }] }]);
    expect(text).toContain("PASS (reduced counts)");
    expect(text).toContain("| a\\|b | x y |");
    expect(text).toContain("Verdict: **thresholds not met**");
  });

  it("the committed results page has a section for each target", async () => {
    const page = await readFile(path.resolve(import.meta.dirname, "../../../../docs/handbook/load-test-results.md"), "utf8");
    for (const t of TARGETS) expect(page).toContain(`<!-- load-run:${t}:start -->`);
    expect(page.startsWith(renderPage({}).split("## Latest run")[0]!)).toBe(true);
  });
});

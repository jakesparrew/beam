/**
 * Writes the load test results page `docs/handbook/load-test-results.md` (platform-P11b). The
 * page keeps one section per target (`beam_dev` at the wave 11 checkpoint, `staging` before
 * go-live); a run replaces only its own target's section, between the markers
 * `<!-- load-run:<target>:start -->` and `<!-- load-run:<target>:end -->`, so the page holds the
 * latest run of each. Commit the page after a run. A failed threshold is a `high` support
 * request (platform spec PL-86).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCENARIO_KEYS = ["portal_booking", "magic_links", "email_drain", "campaign_send"] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

/** The proposal's numbers (section 5). */
export const THRESHOLDS = {
  portal_booking: { connections: 100, durationSec: 60, p95Ms: 800 },
  magic_links: { requests: 50, withinMs: 2 * 60_000 },
  email_drain: { jobs: 5_000, withinMs: 15 * 60_000 },
  campaign_send: { recipients: 20_000, withinMs: 15 * 60_000 },
} as const;

export const SCENARIO_TITLES: Record<ScenarioKey, string> = {
  portal_booking: "100 concurrent visitors on /nl/account/book for 60 s",
  magic_links: "50 concurrent magic-link requests",
  email_drain: "5,000 queued email.send jobs drained by the tick",
  campaign_send: "20,000-recipient campaign on the fake Resend adapter",
};

export const THRESHOLD_TEXT: Record<ScenarioKey, string> = {
  portal_booking: "p95 below 800 ms and no 5xx",
  magic_links: "every email.send job succeeded within 2 minutes",
  email_drain: "every job succeeded within 15 minutes",
  campaign_send: "campaign sent within 15 minutes",
};

export type Metric = { label: string; value: string };

export type ScenarioResult = {
  key: ScenarioKey;
  title: string;
  threshold: string;
  /** `pass` / `fail`; `skipped` when a precondition is missing (for example no `BASE_URL`). */
  outcome: "pass" | "fail" | "skipped";
  /** True when the run used lower counts than the proposal's. */
  reduced: boolean;
  metrics: Metric[];
  startedAt: string;
  durationMs: number;
  note?: string;
};

export const TARGETS = ["local", "beam_dev", "staging"] as const;
export type Target = (typeof TARGETS)[number];

/** What each target's numbers say, printed above its section. */
export const TARGET_NOTES: Record<Target, string> = {
  local:
    "The production build on a Postgres 16 next to it (no network between app and database): the platform's own throughput and query cost, without Neon or Vercel. Full counts.",
  beam_dev:
    "Read for function, not for speed: from the build container every database round trip to Neon in Frankfurt costs about 120 ms (from Vercel fra1 about 1 to 2 ms). The booking page answered every request without errors, but its p95 and the job scenarios' durations measure that distance; the job scenarios ran at reduced counts (`--smoke`).",
  staging: "The thresholds that decide go-live: Vercel fra1 and the staging branch of Neon, full counts.",
};

export const RESULTS_PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/handbook/load-test-results.md");

export type RunMeta = {
  target: Target;
  ranAt: Date;
  commit: string | null;
  baseUrl: string | null;
  /** Whether this process ran the tick (with the fake integrations) or waited for the deployed cron. */
  driveTick: boolean;
};

const startMarker = (t: Target) => `<!-- load-run:${t}:start -->`;
const endMarker = (t: Target) => `<!-- load-run:${t}:end -->`;

const OUTCOME_TEXT: Record<ScenarioResult["outcome"], string> = { pass: "PASS", fail: "FAIL", skipped: "SKIPPED" };

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Whether every scenario passed at the proposal's counts (a reduced or skipped one does not count). */
export function runPassed(results: readonly ScenarioResult[]): boolean {
  return SCENARIO_KEYS.every((k) => results.some((r) => r.key === k && r.outcome === "pass" && !r.reduced));
}

/** The section of one target: summary table, then the metrics of each scenario. */
export function renderSection(meta: RunMeta, results: readonly ScenarioResult[]): string {
  const lines: string[] = [];
  lines.push(`Run ${meta.ranAt.toISOString()}${meta.commit ? ` on commit \`${meta.commit.slice(0, 12)}\`` : ""}${meta.baseUrl ? ` against ${meta.baseUrl}` : ""}.`);
  lines.push(`Tick: ${meta.driveTick ? "run by the load test process with the fake integrations" : "the deployed cron tick"}.`);
  lines.push(`Verdict: **${runPassed(results) ? "all thresholds met" : "thresholds not met"}**.`);
  lines.push("");
  lines.push("| Scenario | Threshold | Result | Duration |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of results) {
    const outcome = `${OUTCOME_TEXT[r.outcome]}${r.reduced ? " (reduced counts)" : ""}`;
    lines.push(`| ${cell(r.title)} | ${cell(r.threshold)} | ${outcome} | ${(r.durationMs / 1000).toFixed(1)} s |`);
  }
  for (const r of results) {
    lines.push("");
    lines.push(`#### ${r.title}`);
    lines.push("");
    if (r.note) lines.push(`Note: ${r.note}`, "");
    if (r.metrics.length) {
      lines.push("| Measure | Value |", "| --- | --- |");
      for (const m of r.metrics) lines.push(`| ${cell(m.label)} | ${cell(m.value)} |`);
    } else {
      lines.push("No measurements.");
    }
  }
  return lines.join("\n");
}

const NOT_RUN = "Not run yet.";

/** The whole page with the given sections (a target without a section shows "Not run yet."). */
export function renderPage(sections: Partial<Record<Target, string>>): string {
  const out: string[] = [
    "# Load test results",
    "",
    "Written by `apps/web/scripts/load/report.ts` when `pnpm test:load` runs (platform spec, platform-P11;",
    "proposal section 5). Do not edit the sections between the markers by hand: the next run of the same",
    "target replaces its section. A failed threshold is a `high` support request (see `support.md`).",
    "",
    "## Scenarios and thresholds",
    "",
    "| Scenario | Threshold |",
    "| --- | --- |",
    ...SCENARIO_KEYS.map((k) => `| ${SCENARIO_TITLES[k]} | ${THRESHOLD_TEXT[k]} |`),
    "",
    "Seat oversell under concurrent booking is covered separately by booking's `book.load.test.ts`.",
    "",
    "## How to run",
    "",
    "```bash",
    "# local: next start against a local Postgres with the demo seed (DATABASE_DRIVER=pg)",
    "BASE_URL=http://localhost:3200 pnpm test:load --target local",
    "# beam_dev (wave 11 checkpoint): next start on the laptop, demo seed loaded",
    "pnpm seed:demo",
    "BASE_URL=http://localhost:3000 pnpm test:load --target beam_dev",
    "# staging, before go-live (DATABASE_URL_UNPOOLED of the staging branch)",
    "BASE_URL=https://staging.beam.be pnpm test:load --target staging",
    "```",
    "",
    "Options: `--only portal_booking,magic_links,email_drain,campaign_send` runs a subset; `--no-drive-tick`",
    "waits for the deployed cron tick instead of running it in the load test process. The scenarios create",
    "`load-<run>-...@demo.beam.be` test persons and messages that stay in the database.",
  ];
  for (const t of TARGETS) {
    out.push("", `## Latest run: \`${t}\``, "", TARGET_NOTES[t], "", startMarker(t), sections[t] ?? NOT_RUN, endMarker(t));
  }
  return `${out.join("\n")}\n`;
}

/** The sections already on the page, by target. */
export function parseSections(page: string): Partial<Record<Target, string>> {
  const out: Partial<Record<Target, string>> = {};
  for (const t of TARGETS) {
    const start = page.indexOf(startMarker(t));
    const end = page.indexOf(endMarker(t));
    if (start < 0 || end < start) continue;
    const body = page.slice(start + startMarker(t).length, end).trim();
    if (body && body !== NOT_RUN) out[t] = body;
  }
  return out;
}

/** Replaces this target's section on the page (creating the page when missing) and returns the page. */
export async function writeReport(meta: RunMeta, results: readonly ScenarioResult[], file: string = RESULTS_PAGE): Promise<string> {
  const existing = await readFile(file, "utf8").catch(() => "");
  const sections = { ...parseSections(existing), [meta.target]: renderSection(meta, results) };
  const page = renderPage(sections);
  await writeFile(file, page);
  return page;
}

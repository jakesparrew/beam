/**
 * `pnpm test:load --target beam_dev|staging [--only <keys>] [--no-drive-tick] [--smoke]`
 * (platform-P11b; proposal section 5; platform spec platform-P11 "Load tests").
 *
 * Runs the four scenarios of `scripts/load/scenarios.ts` against the database of
 * `DATABASE_URL_UNPOOLED` (else `DATABASE_URL`) with the demo seed, and scenario 1 over HTTP
 * against `BASE_URL`, then writes the target's section of `docs/handbook/load-test-results.md`
 * (`scripts/load/report.ts`). Exit code 0 only when every threshold is met at the proposal's
 * counts. Run it at the wave 11 checkpoint against `beam_dev` and before go-live against staging;
 * never against production (`APP_ENV=production` is refused), never in CI, never by a coding
 * agent.
 *
 * The scenarios run in this process: the jobs they queue are run by this process's tick with
 * the fake integrations (no real email leaves), unless `--no-drive-tick`, which waits for the
 * deployed cron tick instead (then the deployment's own integrations apply). `--smoke` lowers
 * every count (10 connections for 10 s, 5 magic links, 50 jobs, 100 recipients) to check the
 * set-up; a smoke run never counts as a pass on the results page.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESULTS_PAGE, runPassed, SCENARIO_KEYS, writeReport, type ScenarioKey } from "./load/report";

/** The https origin the links of a local run use (`.invalid` is reserved, RFC 2606). */
export const LOCAL_HTTPS_APP_URL = "https://beam-dev.invalid";

export const SMOKE_COUNTS ={ connections: 10, durationSec: 10, magicLinks: 5, drainJobs: 50, recipients: 100 } as const;

export type LoadArgs = { target: "beam_dev" | "staging"; only: ScenarioKey[]; driveTick: boolean; smoke: boolean };

/** Parses the command line; throws with a usage line on bad input. */
export function parseArgs(argv: readonly string[]): LoadArgs {
  const usage = "usage: load-test.ts --target beam_dev|staging [--only portal_booking,magic_links,email_drain,campaign_send] [--no-drive-tick] [--smoke]";
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const target = get("target");
  if (target !== "beam_dev" && target !== "staging") throw new Error(usage);
  const onlyRaw = get("only");
  const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim()) : [...SCENARIO_KEYS];
  if (!only.length || only.some((k) => !(SCENARIO_KEYS as readonly string[]).includes(k))) throw new Error(usage);
  return { target, only: only as ScenarioKey[], driveTick: !argv.includes("--no-drive-tick"), smoke: argv.includes("--smoke") };
}

/**
 * `server-only` throws outside a React Server Component build; the module code this script
 * calls imports it. The same stub vitest uses (DR-9): resolve it to an empty module.
 */
function stubServerOnly(): void {
  const hook = `export async function resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    return next(specifier, context);
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  const { config } = await import("dotenv");
  config({ path: ["../../.env.local", "../../.env", ".env.local"], quiet: true });
  let args: LoadArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  if (process.env.APP_ENV === "production") {
    console.error("load-test: refused, APP_ENV=production (run against beam_dev or staging only)");
    return 2;
  }
  if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
  if (!process.env.DATABASE_URL) {
    console.error("load-test: DATABASE_URL_UNPOOLED or DATABASE_URL is required");
    return 2;
  }
  // Marketing mail refuses a non-https List-Unsubscribe link (email rule 52). On a laptop
  // APP_URL is http://localhost:3000; the links of this process's (fake) sends then use a
  // reserved https host instead. The deployment itself keeps its own APP_URL.
  if (!(process.env.APP_URL ?? "").startsWith("https://")) process.env.APP_URL = LOCAL_HTTPS_APP_URL;
  stubServerOnly();
  const [{ getDbHandle }, ctxLib, integrationsLib, scenarios] = await Promise.all([
    import("@beam/db"),
    import("@/lib/ctx"),
    import("@/lib/integrations"),
    import("./load/scenarios"),
  ]);
  const handle = await getDbHandle();
  const integrations = integrationsLib.createFakeIntegrations();
  ctxLib.setAppDb(handle.db);
  integrationsLib.setIntegrations(integrations);
  const runId = randomBytes(6).toString("hex").slice(0, 8);
  const baseUrl = process.env.BASE_URL?.replace(/\/$/, "") || undefined;
  console.log(`load-test: run ${runId}, target ${args.target}${baseUrl ? `, ${baseUrl}` : ""}${args.smoke ? ", smoke counts" : ""}`);
  try {
    const results = await scenarios.runScenarios(
      {
        db: handle.db,
        integrations,
        runId,
        baseUrl,
        driveTick: args.driveTick,
        ...(args.smoke ? { counts: SMOKE_COUNTS } : {}),
        log: (line) => console.log(`load-test: ${line}`),
      },
      args.only,
    );
    const meta = { target: args.target, ranAt: new Date(), commit: gitCommit(), baseUrl: baseUrl ?? null, driveTick: args.driveTick };
    await writeReport(meta, results);
    const passed = runPassed(results);
    console.log(`load-test: ${passed ? "every threshold met" : "thresholds not met"}; wrote ${path.relative(process.cwd(), RESULTS_PAGE)}`);
    return passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    integrationsLib.setIntegrations(undefined);
    await handle.close();
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

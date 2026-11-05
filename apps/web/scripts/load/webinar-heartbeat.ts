/**
 * Webinar heartbeat load test (webinar spec section 12, webinar-P4): run against a preview
 * deployment before the R2 acceptance, never in CI and never by a coding agent. It drives N
 * simulated viewers (default 300) of one live webinar: each starts a view (`POST
 * /api/webinar/view`) and then sends one heartbeat every 15 s for the duration (default 10
 * minutes), with a random start offset so the beats spread over the interval. The pass criteria
 * are p95 below 300 ms and no 5xx; paste the summary into the PR.
 *
 * Plain `fetch`, no dependency. Usage:
 *
 *   BASE_URL=https://<preview>.vercel.app WEBINAR_ID=<uuid> TOKENS_FILE=tokens.txt \
 *     pnpm --filter @beam/web exec tsx scripts/load/webinar-heartbeat.ts
 *
 * `TOKENS_FILE` holds one personal access token per line (registrations of demo persons with
 * `@demo.beam.be` addresses on the preview database); viewers reuse tokens round-robin when there
 * are fewer tokens than viewers (two tabs of one registration are allowed, edge case 2; more than
 * two per registration hit the 8-per-minute bucket by design). Optional: `VIEWERS`,
 * `DURATION_SEC`, `P95_LIMIT_MS`. Tokens are never printed.
 */
import { readFileSync } from "node:fs";

type Sample = { ms: number; status: number };

const env = process.env;
const BASE_URL = (env.BASE_URL ?? "").replace(/\/$/, "");
const WEBINAR_ID = env.WEBINAR_ID ?? "";
const VIEWERS = Number(env.VIEWERS ?? 300);
const DURATION_SEC = Number(env.DURATION_SEC ?? 600);
const P95_LIMIT_MS = Number(env.P95_LIMIT_MS ?? 300);
const INTERVAL_MS = 15_000;

function fail(message: string): never {
  console.error(`webinar-heartbeat: ${message}`);
  process.exit(2);
}

function loadTokens(): string[] {
  if (!env.TOKENS_FILE) fail("TOKENS_FILE is required (one access token per line)");
  const tokens = readFileSync(env.TOKENS_FILE, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!tokens.length) fail("TOKENS_FILE holds no tokens");
  return tokens;
}

async function timed(path: string, token: string, body: unknown): Promise<{ sample: Sample; json: unknown }> {
  const started = performance.now();
  let status = 0;
  let json: unknown = null;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webinar-token": token },
      body: JSON.stringify(body),
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    status = 599;
  }
  return { sample: { ms: performance.now() - started, status }, json };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function viewer(token: string, until: number, beats: Sample[], views: Sample[]): Promise<void> {
  await sleep(Math.random() * INTERVAL_MS);
  const start = await timed("/api/webinar/view", token, { webinarId: WEBINAR_ID });
  views.push(start.sample);
  const view = start.json as { viewId?: string; mode?: string; startSec?: number } | null;
  if (!view?.viewId || !view.mode) return;
  let position = view.startSec ?? 0;
  while (Date.now() + INTERVAL_MS < until) {
    await sleep(INTERVAL_MS);
    const from = position;
    position += INTERVAL_MS / 1000;
    const beat = await timed("/api/webinar/heartbeat", token, { webinarId: WEBINAR_ID, viewId: view.viewId, mode: view.mode, fromSec: from, toSec: position, state: "playing" });
    beats.push(beat.sample);
    if (beat.sample.status === 409 || beat.sample.status === 403) return;
  }
}

async function main(): Promise<void> {
  if (!BASE_URL) fail("BASE_URL is required");
  if (!/^[0-9a-f-]{36}$/.test(WEBINAR_ID)) fail("WEBINAR_ID must be the webinar's uuid");
  const tokens = loadTokens();
  const until = Date.now() + DURATION_SEC * 1000;
  const beats: Sample[] = [];
  const views: Sample[] = [];
  console.log(`webinar-heartbeat: ${VIEWERS} viewers, ${DURATION_SEC} s, ${tokens.length} tokens, ${BASE_URL}`);
  await Promise.all(Array.from({ length: VIEWERS }, (_, i) => viewer(tokens[i % tokens.length]!, until, beats, views)));

  const byStatus = new Map<number, number>();
  for (const s of beats) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const ok = beats.filter((s) => s.status < 500).map((s) => s.ms);
  const p50 = percentile(ok, 50);
  const p95 = percentile(ok, 95);
  const p99 = percentile(ok, 99);
  const fiveXx = beats.filter((s) => s.status >= 500).length + views.filter((s) => s.status >= 500).length;
  console.log(
    JSON.stringify(
      {
        heartbeats: beats.length,
        views: views.length,
        statuses: Object.fromEntries([...byStatus.entries()].sort((a, b) => a[0] - b[0])),
        p50_ms: Math.round(p50),
        p95_ms: Math.round(p95),
        p99_ms: Math.round(p99),
        five_xx: fiveXx,
        pass: p95 < P95_LIMIT_MS && fiveXx === 0,
      },
      null,
      2,
    ),
  );
  process.exit(p95 < P95_LIMIT_MS && fiveXx === 0 ? 0 : 1);
}

void main();

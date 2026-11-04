/**
 * Health signals of the automation engine (A-45, platform PL-75a "Failed automations" check,
 * owned by this module). The sweep raises them every 15 minutes through `platform.notifySlack`,
 * whose key `slack:<fingerprint>:<Brussels hour>` keeps each fingerprint to one Slack job per hour.
 *
 * - (a) `automation-stuck` (high): an enrolment of an active automation more than 30 minutes past
 *   `next_step_at`;
 * - (b) `automation-lag` (high): the oldest unprocessed `activity_events` row is more than
 *   5 minutes old;
 * - (c) `automation-failures` (high): more than 20 `failed` runs in the last hour;
 * - `automation-translation:<template_slug>` (normal): `skipped_translation` runs of a template
 *   in the last hour.
 */
import type { DbOrTx } from "@beam/db";
import { sql, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { notifySlack } from "@/modules/platform/api";
import { evaluatorLagSeconds } from "./cursor";

export const STUCK_AFTER_MINUTES = 30;
export const LAG_ALERT_SECONDS = 5 * 60;
export const FAILED_RUNS_PER_HOUR_LIMIT = 20;

export type AutomationHealth = {
  stuck: number;
  lagSeconds: number;
  failedLastHour: number;
  translationSkips: { templateSlug: string; count: number }[];
};

export type HealthAlert = { fingerprint: string; severity: "high" | "normal"; text: string };

/** The numbers behind the alerts at `now`. */
export async function readHealth(db: DbOrTx, now: Date): Promise<AutomationHealth> {
  const iso = now.toISOString();
  const [stuck] = rowsOf<{ n: number | string }>(
    await db.execute(sql`select count(*) as n from automation_enrolments e join automations a on a.id = e.automation_id
      where e.status = 'active' and a.status = 'active'
        and e.next_step_at < ${iso}::timestamptz - make_interval(mins => ${STUCK_AFTER_MINUTES})`),
  );
  const [failed] = rowsOf<{ n: number | string }>(
    await db.execute(sql`select count(*) as n from automation_runs
      where outcome = 'failed' and occurred_at > ${iso}::timestamptz - interval '1 hour' and occurred_at <= ${iso}::timestamptz`),
  );
  const translation = rowsOf<{ slug: string | null; n: number | string }>(
    await db.execute(sql`select data->>'template_slug' as slug, count(*) as n from automation_runs
      where outcome = 'skipped_translation' and occurred_at > ${iso}::timestamptz - interval '1 hour' and occurred_at <= ${iso}::timestamptz
      group by 1 order by 1`),
  );
  return {
    stuck: Number(stuck?.n ?? 0),
    lagSeconds: await evaluatorLagSeconds(db, now),
    failedLastHour: Number(failed?.n ?? 0),
    translationSkips: translation.map((t) => ({ templateSlug: t.slug ?? "unknown", count: Number(t.n) })),
  };
}

/** The alerts the numbers call for (thresholds of A-45; at the threshold nothing fires). */
export function healthAlerts(h: AutomationHealth): HealthAlert[] {
  const out: HealthAlert[] = [];
  if (h.stuck > 0) {
    out.push({ fingerprint: "automation-stuck", severity: "high", text: `${h.stuck} automation enrolment(s) are more than ${STUCK_AFTER_MINUTES} minutes past their next step.` });
  }
  if (h.lagSeconds > LAG_ALERT_SECONDS) {
    out.push({ fingerprint: "automation-lag", severity: "high", text: `The automation evaluator lags: the oldest unprocessed event is ${Math.round(h.lagSeconds / 60)} minutes old.` });
  }
  if (h.failedLastHour > FAILED_RUNS_PER_HOUR_LIMIT) {
    out.push({ fingerprint: "automation-failures", severity: "high", text: `${h.failedLastHour} automation steps failed in the last hour.` });
  }
  for (const t of h.translationSkips) {
    out.push({
      fingerprint: `automation-translation:${t.templateSlug}`,
      severity: "normal",
      text: `${t.count} automation email(s) skipped in the last hour: template ${t.templateSlug} lacks the recipient's language.`,
    });
  }
  return out;
}

/** Reads the health and enqueues one Slack job per alert (per fingerprint per hour). */
export async function raiseHealthAlerts(ctx: Ctx, now: Date): Promise<{ health: AutomationHealth; alerts: string[] }> {
  const health = await readHealth(ctx.tx, now);
  const alerts = healthAlerts(health);
  for (const a of alerts) await notifySlack(ctx, a);
  return { health, alerts: alerts.map((a) => a.fingerprint) };
}

/**
 * Platform's door for every module (platform spec 4.8). These are the only names; other specs'
 * aliases map to them (`callClaude`, `storeFile`, `listStaffForAssignment`, `ctx.integrationLog`).
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError, ForbiddenError } from "@beam/core/errors";
import { isGateComplete, type GoLiveGate } from "@beam/core/platform";
import type { RoleKey } from "@beam/db/schema";
import { actorHasPermission, ConflictError, sql, type Ctx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { appEnv } from "@/lib/integrations";
import { aiSpendThisMonthCents, databaseSizeBytes, filesSizeBytes, filesSizeLevel, GB } from "@/lib/alerts";
import { getSetting } from "@/lib/settings";
import { rowsOf } from "@/lib/sensitive";
import type { Permission } from "@/registry/types.generated";

export { recordEvent } from "@/lib/events";
export { audit } from "@/lib/audit";
export { enqueueJob as enqueue } from "@/lib/ctx";
export { getSetting, setSetting, writeSystemSetting } from "@/lib/settings";
export { flag } from "@/lib/flags";
export { storeFile, readFile, signFileUrl } from "@/lib/files";
export { encryptSensitive, decryptSensitive, readSensitive, encryptNote, sensitiveAad } from "@/lib/sensitive";
export { callClaude } from "@/lib/ai";
export { notifySlack } from "@/lib/alerts";
export { actorHasPermission as hasPermission } from "@/lib/ctx";
export { belgianPublicHolidays, slaDueAt } from "@beam/core/platform";

/** PL-77: all 13 items confirmed. Outside production the gate never blocks (it returns true). */
export async function isGoLiveGateComplete(tx: DbOrTx): Promise<boolean> {
  if (appEnv() !== "production") return true;
  return isGateComplete((await getSetting(tx, "go_live_gate")) as GoLiveGate);
}

export type DigestSection = { title: string; lines: { label: string; value: string; level: "ok" | "warn" | "alert" }[] };

const n = (v: unknown) => Number(v ?? 0);

/** The platform part of ops' daily digest (lines of spec 4.8), counts only. */
export async function getPlatformDigest(tx: DbOrTx, day: string): Promise<DigestSection> {
  void day;
  const one = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await tx.execute(q))[0]!;
  const dead = await one<{ n: number }>(sql`select count(*)::int as n from jobs where status = 'dead' and finished_at > now() - interval '24 hours'`);
  const support = await one<{ open: number; breached: number }>(
    sql`select count(*) filter (where status in ('open', 'responded'))::int as open, count(*) filter (where is_breached and status = 'open')::int as breached from v_support_sla`,
  );
  const backlog = await one<{ n: number; oldest: number | null }>(
    sql`select count(*)::int as n, extract(epoch from now() - min(run_at))::int as oldest from jobs where status = 'pending' and run_at <= now()`,
  );
  const tick = (await getSetting(tx, "last_tick_at")) as string | null;
  const tickAge = tick ? Math.round((Date.now() - new Date(tick).getTime()) / 1000) : null;
  const hooks = await one<{ events: number; failures: number }>(sql`
    select (select count(*)::int from webhook_events where received_at > now() - interval '24 hours') as events,
           (select count(*)::int from integration_calls where operation = 'webhook.signature_failed' and created_at > now() - interval '24 hours') as failures`);
  const errors = rowsOf<{ provider: string; n: number }>(
    await tx.execute(sql`select provider::text as provider, count(*)::int as n from integration_calls where not ok and created_at > now() - interval '24 hours' group by provider order by provider`),
  );
  const ai = (await getSetting(tx, "ai")) as { monthly_budget_cents: number };
  const spend = await aiSpendThisMonthCents(tx);
  const files = await filesSizeBytes(tx);
  const dbSize = await databaseSizeBytes(tx);
  const incidents = await one<{ n: number }>(sql`select count(*)::int as n from security_incidents where status <> 'resolved'`);

  const lines: DigestSection["lines"] = [
    { label: "Dead jobs (24 h)", value: String(n(dead.n)), level: n(dead.n) > 0 ? "warn" : "ok" },
    { label: "Open support requests", value: `${n(support.open)} (${n(support.breached)} past due)`, level: n(support.breached) > 0 ? "alert" : "ok" },
    { label: "Pending backlog", value: String(n(backlog.n)), level: n(backlog.n) > 500 ? "alert" : n(backlog.n) > 100 ? "warn" : "ok" },
    { label: "Oldest pending job", value: backlog.oldest === null ? "-" : `${n(backlog.oldest)} s`, level: n(backlog.oldest) > 600 ? "warn" : "ok" },
    { label: "Last tick", value: tickAge === null ? "never" : `${tickAge} s ago`, level: tickAge === null || tickAge > 180 ? "warn" : "ok" },
    { label: "Webhook events (24 h)", value: `${n(hooks.events)} (${n(hooks.failures)} signature failures)`, level: n(hooks.failures) > 5 ? "warn" : "ok" },
    ...errors.map((e) => ({ label: `Integration errors: ${e.provider} (24 h)`, value: String(n(e.n)), level: "warn" as const })),
    {
      label: "AI spend this month",
      value: `${(spend / 100).toFixed(2)} of ${(n(ai.monthly_budget_cents) / 100).toFixed(2)} EUR`,
      level: ai.monthly_budget_cents > 0 && spend > ai.monthly_budget_cents * 0.8 ? "warn" : "ok",
    },
    { label: "Files total size", value: `${(files / GB).toFixed(2)} GB`, level: filesSizeLevel(files) },
    { label: "Database size", value: `${(dbSize / GB).toFixed(2)} GB`, level: dbSize > 8 * GB ? "warn" : "ok" },
    { label: "Open security incidents", value: String(n(incidents.n)), level: n(incidents.n) > 0 ? "alert" : "ok" },
  ];
  return { title: "Platform", lines };
}

export async function getCustomerAccount(
  tx: DbOrTx,
  personId: string,
): Promise<{ userId: string; email: string; lastLoginAt: Date | null; hasPassword: boolean } | null> {
  const row = rowsOf<{ id: string; email: string; last_login_at: string | Date | null; has_password: boolean }>(
    await tx.execute(sql`select id::text as id, email, last_login_at, (password_hash is not null) as has_password from users where person_id = ${personId} and audience = 'customer' limit 1`),
  )[0];
  if (!row) return null;
  return { userId: row.id, email: row.email, lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null, hasPassword: !!row.has_password };
}

/** Edge case 14: the winner keeps its account; the loser's is deleted, or moved when the winner has none. */
export async function reassignCustomerAccount(ctx: Ctx, input: { fromPersonId: string; toPersonId: string }): Promise<{ moved: boolean }> {
  const loser = await getCustomerAccount(ctx.tx, input.fromPersonId);
  if (!loser) return { moved: false };
  const winner = await getCustomerAccount(ctx.tx, input.toPersonId);
  if (winner) {
    await ctx.tx.execute(sql`delete from users where id = ${loser.userId}::uuid`);
    return { moved: false };
  }
  await ctx.tx.execute(sql`update users set person_id = ${input.toPersonId}::uuid, updated_at = now() where id = ${loser.userId}::uuid`);
  return { moved: true };
}

/** Edge case 13: the account follows the person's email; another user's email is `conflict`. */
export async function syncCustomerAccountEmail(ctx: Ctx, input: { personId: string; email: string | null }): Promise<void> {
  if (!input.email) return;
  const email = input.email.trim().toLowerCase();
  const account = await getCustomerAccount(ctx.tx, input.personId);
  if (!account || account.email === email) return;
  const taken = rowsOf(await ctx.tx.execute(sql`select 1 from users where lower(email) = ${email} and id <> ${account.userId}::uuid limit 1`));
  if (taken.length) throw new ConflictError("email_in_use");
  await ctx.tx.execute(sql`update users set email = ${email}, updated_at = now() where id = ${account.userId}::uuid`);
  await ctx.tx.execute(sql`delete from auth_verification_tokens where identifier = ${account.email}`);
}

export async function listStaffForAssignment(
  tx: DbOrTx,
  opts: { roleKey?: RoleKey; permission?: Permission } = {},
): Promise<{ userId: string; name: string; roleKey: RoleKey }[]> {
  const role = opts.roleKey ? sql` and u.role_key = ${opts.roleKey}` : sql``;
  const perm = opts.permission ? sql` and (${opts.permission} = any(r.permissions) or '*' = any(r.permissions))` : sql``;
  const rows = rowsOf<{ id: string; name: string | null; email: string; role_key: RoleKey }>(
    await tx.execute(sql`
      select u.id::text as id, u.name, u.email, u.role_key::text as role_key from users u join roles r on r.key = u.role_key
      where u.audience = 'staff' and u.status = 'active'${role}${perm} order by coalesce(u.name, u.email)`),
  );
  return rows.map((r) => ({ userId: r.id, name: r.name ?? r.email, roleKey: r.role_key }));
}

/** R3 (platform-P9): the partner's company; `ForbiddenError` without `partner.own`. */
export async function partnerScope(ctx: Ctx): Promise<{ companyId: string }> {
  if (ctx.actor.kind !== "staff" || !actorHasPermission(ctx.actor, "partner.own")) throw new ForbiddenError("forbidden: partner.own", "partner.own");
  const row = rowsOf<{ company_id: string | null }>(
    await ctx.tx.execute(sql`select p.partner_company_id::text as company_id from users u join persons p on p.id = u.person_id where u.id = ${ctx.actor.userId}::uuid`),
  )[0];
  if (!row?.company_id) throw new ForbiddenError("forbidden: no partner company", "partner.own");
  return { companyId: row.company_id };
}

/**
 * R3 (platform-P9): the read scope of a view that staff and partners share (crm, booking and ops
 * partner views). `{ companyId: null }` means unrestricted: a staff member holding `permission`.
 * `{ companyId }` means "only this company's rows": an `external_partner` user (always scoped,
 * even when an owner granted the role more permissions), or a staff member without `permission`
 * who holds `partner.own` and is linked to a partner company. Anyone else gets `ForbiddenError`.
 */
export async function requirePartnerOrPermission(ctx: Ctx, permission: Permission): Promise<{ companyId: string | null }> {
  const actor = ctx.actor;
  if (actor.kind !== "staff") throw new ForbiddenError(`forbidden: ${permission}`, permission);
  if (actor.roleKey === "external_partner") return partnerScope(ctx);
  if (actorHasPermission(actor, permission)) return { companyId: null };
  if (actorHasPermission(actor, "partner.own")) return partnerScope(ctx);
  throw new ForbiddenError(`forbidden: ${permission}`, permission);
}

/** R4 (platform-P10). */
export function runAiReadOnlyQuery(ctx: JobCtx, sqlText: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  void ctx;
  void sqlText;
  return Promise.reject(new NotImplementedError("platform.runAiReadOnlyQuery (R4, platform-P10)"));
}

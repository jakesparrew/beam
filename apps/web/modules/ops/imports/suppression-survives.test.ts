import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { consentRecords } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { IMPORT_PRESETS, type ImportMapping } from "@beam/core/ops";

// automation's stub throws until its package lands; crm's unsubscribe and addSuppression call it.
vi.mock("@/modules/automation/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), requestSuppressionExit: vi.fn().mockResolvedValue({ jobId: null }) }));

const { eq, sql } = await import("@/lib/ctx");
const { makeCtx, resetRuntime } = await import("@/lib/testing");
const { unsubscribe } = await import("@/modules/crm/api");
const { baseOptions, dryRun, importOf, realRun, rowsOf, seedImport } = await import("./ops-p4.fixtures");

let h: DbHandle;

/** email's `v_marketing_reachability` (02-data-model 6), created here while email has not shipped it. */
const REACHABILITY_SQL = `create view v_marketing_reachability as
with base as (
  select p.id as person_id, ss.purpose,
    case
      when p.erased_at is not null then 'erased'
      when p.email is null then 'no_email'
      when p.processing_restricted_at is not null then 'restricted'
      when ss.is_suppressed then 'suppressed'
      when c.status = 'withdrawn' then 'withdrawn'
      when c.status = 'granted' then null
      else 'no_consent'
    end as blocked_reason
  from persons p
  join v_suppression_status ss on ss.person_id = p.id
  left join v_consent_current c on c.person_id = p.id and c.purpose::text = ss.purpose
  where p.merged_into_person_id is null
)
select person_id, purpose, blocked_reason, blocked_reason is null as is_reachable from base`;

beforeAll(async () => {
  h = await createTestDb();
  const exists = (await h.db.execute(sql`select 1 from pg_views where viewname = 'v_marketing_reachability'`)) as unknown as { rows: unknown[] };
  if (!exists.rows.length) await h.db.execute(sql.raw(REACHABILITY_SQL));
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const mailchimpMapping = (): ImportMapping => ({ columns: { ...IMPORT_PRESETS.mailchimp_consents.columns }, options: baseOptions({ preset: "mailchimp_consents", consentPurpose: "newsletter" }) });

async function reachable(personId: string): Promise<{ is_reachable: boolean; blocked_reason: string | null } | undefined> {
  const res = (await h.db.execute(sql`select is_reachable, blocked_reason from v_marketing_reachability where person_id = ${personId}::uuid and purpose = 'newsletter'`)) as unknown as {
    rows: { is_reachable: boolean; blocked_reason: string | null }[];
  };
  return res.rows[0];
}

describe("acceptance: a suppression survives the import (ops rule 47, edge case 8)", () => {
  it("R47 unsubscribe, then a Mailchimp 'subscribed' import: the consent row is skipped and the person stays unreachable", async () => {
    const p = await makePerson(h.db, { email: "survivor@example.com" });
    await h.db.insert(consentRecords).values({ personId: p.id, purpose: "newsletter", status: "granted", method: "form", source: "form:intake", wordingVersion: "newsletter@1", recordedAt: new Date("2025-01-01T10:00:00Z"), actor: { kind: "system", id: null } });
    expect(await reachable(p.id)).toMatchObject({ is_reachable: true });

    const ctx = makeCtx(h.db, { actor: { kind: "customer", userId: p.id, personId: p.id } });
    await unsubscribe(h.db as unknown as Tx, ctx, { personId: p.id, purpose: "all", method: "unsubscribe_link", source: "email" });
    expect(await reachable(p.id)).toMatchObject({ is_reachable: false });

    const csv = "Email Address,Status,CONFIRM_TIME,Source\nSurvivor@example.com,subscribed,2026-02-01T10:00:00Z,Mailchimp form\n";
    const id = await seedImport(h.db, { kind: "consents", source: "mailchimp", name: "Mailchimp audience", csv, mapping: mailchimpMapping() });
    await dryRun(h.db, id);
    expect((await rowsOf(h.db, id)).map((r) => [r.dryRunStatus, r.message])).toEqual([["skipped", "suppressed"]]);
    await realRun(h.db, id);
    expect((await rowsOf(h.db, id)).map((r) => [r.status, r.message])).toEqual([["skipped", "suppressed"]]);
    expect((await importOf(h.db, id)).report).toMatchObject({ run: { suppressed_skipped: [1] } });

    expect(await reachable(p.id)).toMatchObject({ is_reachable: false });
    const records = await h.db.select({ status: consentRecords.status, method: consentRecords.method }).from(consentRecords).where(eq(consentRecords.personId, p.id)).orderBy(consentRecords.recordedAt);
    expect(records.some((r) => r.method === "import")).toBe(false);
  });

  it("R47 a scoped newsletter unsubscribe also blocks a newsletter grant from an import", async () => {
    const p = await makePerson(h.db, { email: "scoped@example.com" });
    const ctx = makeCtx(h.db, { actor: { kind: "customer", userId: p.id, personId: p.id } });
    await unsubscribe(h.db as unknown as Tx, ctx, { personId: p.id, purpose: "newsletter", method: "unsubscribe_link", source: "email" });
    const id = await seedImport(h.db, { kind: "consents", source: "mailchimp", csv: "Email Address,Status,CONFIRM_TIME,Source\nscoped@example.com,subscribed,2026-02-01T10:00:00Z,x\n", mapping: mailchimpMapping() });
    await dryRun(h.db, id);
    await realRun(h.db, id);
    expect((await rowsOf(h.db, id)).map((r) => [r.status, r.message])).toEqual([["skipped", "suppressed"]]);
    expect((await reachable(p.id))?.is_reachable).toBe(false);
  });
});

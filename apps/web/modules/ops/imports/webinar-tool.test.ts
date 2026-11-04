import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, consentRecords, importedHistory, persons, suppressions } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { emailHash } from "@beam/core/crm";
import { IMPORT_PRESETS, IMPORT_TARGETS, presetTargetsValid, WEBINAR_PRESET_KEYS, type ImportMapping } from "@beam/core/ops";
import { like } from "drizzle-orm";
import { eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { emailDigest16 } from "./apply";
import { baseOptions, dryRun, importOf, realRun, rowsOf, seedImport, tableCounts } from "./ops-p4.fixtures";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const HEADER = "Email;Watched at;Webinar title;Broadcast date;Webinar ID;Watched minutes;Opt-in";
const attendeesMapping = (): ImportMapping => ({
  columns: { ...IMPORT_PRESETS.webinargeek_attendees.columns, "Watched minutes": "watched_minutes", "Opt-in": null },
  options: baseOptions({ preset: "webinargeek_attendees", delimiter: ";", dateFormat: "dd/mm/yyyy", defaultLocale: "en" }),
});
const registrantsMapping = (): ImportMapping => ({
  columns: { ...IMPORT_PRESETS.webinargeek_registrants.columns, "Opt-in": null },
  options: baseOptions({ preset: "webinargeek_registrants", delimiter: ";", dateFormat: "dd/mm/yyyy" }),
});
const regHeader = "Email;Registration date;Webinar title;Broadcast date;Webinar ID;Opt-in";

async function runWebinar(csv: string, mapping: ImportMapping, name = "WebinarGeek export") {
  const id = await seedImport(h.db, { kind: "history", source: "webinar_tool", name, csv, mapping });
  await dryRun(h.db, id);
  await realRun(h.db, id);
  return id;
}

describe("webinar tool imports (webinar spec V1 rules 1-7, ops rule 47a)", () => {
  it("rule 1: the four presets map only to history targets", () => {
    for (const key of WEBINAR_PRESET_KEYS) {
      const preset = IMPORT_PRESETS[key];
      expect(preset).toMatchObject({ kind: "history", source: "webinar_tool" });
      expect(presetTargetsValid(preset)).toBe(true);
      for (const target of Object.values(preset.columns)) expect(IMPORT_TARGETS.history).toContain(target);
    }
  });

  it("rule 2: no email is skipped missing_email, an invalid one is error invalid_email; the report holds row numbers and codes only", async () => {
    const csv = `${regHeader}\n;01/10/2026 10:00;Slaap beter;15/10/2026 19:00;WG-100;yes\nnot-an-email;01/10/2026 10:00;Slaap beter;15/10/2026 19:00;WG-100;yes\n`;
    const id = await runWebinar(csv, registrantsMapping());
    const rows = await rowsOf(h.db, id);
    expect(rows.map((r) => [r.status, r.message])).toEqual([
      ["skipped", "missing_email"],
      ["error", "invalid_email"],
    ]);
    const imp = await importOf(h.db, id);
    expect(imp.status).toBe("done");
    expect(JSON.stringify(imp.report)).not.toMatch(/not-an-email|@/);
    expect((imp.report as { run: { invalid_emails: number[]; missing_emails: number[] } }).run).toMatchObject({ invalid_emails: [2], missing_emails: [1] });
  });

  it("rule 3: a new person gets acquisition webinar with the old tool's title and locale nl-BE; an existing person's acquisition stays", async () => {
    const existing = await makePerson(h.db, { email: "known-webinar@example.com", acquisition: { source: "website" }, locale: "fr-BE" });
    const csv = `${HEADER}\nfresh-webinar@example.com;15/10/2026 19:05;Slaap beter;15/10/2026 19:00;WG-200;42;yes\nknown-webinar@example.com;15/10/2026 19:05;Slaap beter;15/10/2026 19:00;WG-200;10;yes\n`;
    await runWebinar(csv, attendeesMapping());
    const [fresh] = await h.db.select().from(persons).where(eq(persons.email, "fresh-webinar@example.com"));
    expect(fresh).toMatchObject({ locale: "nl-BE" });
    expect(fresh!.acquisition).toMatchObject({ source: "webinar", campaign: "Slaap beter" });
    const [known] = await h.db.select().from(persons).where(eq(persons.id, existing.id));
    expect(known!.acquisition).toMatchObject({ source: "website" });
    expect(known!.locale).toBe("fr-BE");
  });

  it("rule 4: no consent or suppression row is written, even with an opt-in column", async () => {
    const before = await tableCounts(h.db, ["consent_records", "suppressions"]);
    await runWebinar(`${regHeader}\noptin@example.com;01/10/2026 10:00;Ademwerk;20/10/2026 19:00;WG-300;yes\n`, registrantsMapping());
    expect(await tableCounts(h.db, ["consent_records", "suppressions"])).toEqual(before);
    const [p] = await h.db.select({ id: persons.id }).from(persons).where(eq(persons.email, "optin@example.com"));
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p!.id))).toEqual([]);
  });

  it("rule 47a: an erased address is skipped with erased", async () => {
    await h.db.insert(suppressions).values({ emailHash: emailHash("erased-webinar@example.com"), scope: "all", reason: "erased", source: "privacy", actor: { kind: "system", id: null } });
    const id = await runWebinar(`${regHeader}\nErased-Webinar@example.com;01/10/2026 10:00;Ademwerk;20/10/2026 19:00;WG-300;yes\n`, registrantsMapping());
    expect((await rowsOf(h.db, id)).map((r) => [r.status, r.message])).toEqual([["skipped", "erased"]]);
    expect(await h.db.select().from(persons).where(eq(persons.email, "erased-webinar@example.com"))).toEqual([]);
  });

  it("rule 5: external id = <provider>:<webinar id>:<first 16 hex of sha256(lower(email))>; attendance carries mode and watched minutes", async () => {
    await runWebinar(`${HEADER}\nAttendee.One@example.com;16/10/2026 09:00;Slaap beter;15/10/2026 19:00;WG-400;35;\n`, attendeesMapping());
    const ext = `webinargeek:WG-400:${emailDigest16("attendee.one@example.com")}`;
    expect(emailDigest16("attendee.one@example.com")).toMatch(/^[0-9a-f]{16}$/);
    const rows = await h.db.select().from(importedHistory).where(eq(importedHistory.externalId, ext)).orderBy(importedHistory.kind);
    expect(rows.map((r) => r.kind)).toEqual(["webinar_registration", "webinar_attendance"]);
    expect(rows[1]!.data).toMatchObject({ provider: "webinargeek", external_webinar_id: "WG-400", title: "Slaap beter", mode: "replay", watched_minutes: 35 });
    expect(rows[1]!.data).toHaveProperty("starts_at");
  });

  it("rule 6: no webinar.* event and no automation enrolment after the import; only ops.history_imported", async () => {
    await runWebinar(`${HEADER}\nno-events@example.com;15/10/2026 19:10;Slaap beter;15/10/2026 19:00;WG-500;50;yes\n`, attendeesMapping());
    const [p] = await h.db.select({ id: persons.id }).from(persons).where(eq(persons.email, "no-events@example.com"));
    expect(await h.db.select().from(activityEvents).where(like(activityEvents.kind, "webinar.%"))).toEqual([]);
    const kinds = (await h.db.select({ kind: activityEvents.kind }).from(activityEvents).where(eq(activityEvents.personId, p!.id))).map((e) => e.kind);
    expect(kinds.filter((k) => k === "ops.history_imported")).toHaveLength(2);
    const enrolments = (await h.db.execute(sql`select count(*)::int as n from automation_enrolments`)) as unknown as { rows: { n: number }[] };
    expect(enrolments.rows[0]!.n).toBe(0);
  });

  it("rule 7: the dry run writes only imports and import_rows; a weekly re-import adds nothing", async () => {
    const csv = `${HEADER}\nweekly@example.com;15/10/2026 19:10;Slaap beter;15/10/2026 19:00;WG-600;50;yes\n`;
    const tables = ["persons", "imported_history", "activity_events", "consent_records", "suppressions", "import_external_ids"];
    const id = await seedImport(h.db, { kind: "history", source: "webinar_tool", csv, mapping: attendeesMapping() });
    const before = await tableCounts(h.db, tables);
    await dryRun(h.db, id);
    expect(await tableCounts(h.db, tables)).toEqual(before);
    await realRun(h.db, id);
    const afterFirst = await tableCounts(h.db, tables);
    expect(afterFirst.imported_history).toBe(before.imported_history! + 2);
    const again = await runWebinar(csv, attendeesMapping(), "Weekly re-import");
    expect(await tableCounts(h.db, tables)).toEqual(afterFirst);
    expect((await rowsOf(h.db, again)).map((r) => [r.status, r.message])).toEqual([["skipped", "existing"]]);
  });
});

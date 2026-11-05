/**
 * automation-P4's interim `PersonAutomationsPanel` (platform-P7 request): renders without
 * throwing, shows the empty state, active and ended journeys and the timeline of one person only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { createTestDb, makePerson } from "@beam/db/testing";
import { resetRuntime } from "@/lib/testing";
import { PersonAutomationsPanel } from "./ui/person-automations-panel";
import { endEnrolment } from "./engine/exits";
import { def, enrolInto, makeAutomation, SYSTEM } from "./engine/automation-p3.fixtures";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const render = async (personId: string) => renderToStaticMarkup(await PersonAutomationsPanel({ personId, db: h.db, locale: "en" }));

describe("PersonAutomationsPanel (interim, automation-P4)", () => {
  it("shows the empty state for a person in no journey", async () => {
    const p = await makePerson(h.db);
    const html = await render(p.id);
    expect(html).toContain('data-testid="automation-panel-empty"');
    expect(html).not.toContain("automation-panel-timeline");
  });

  it("lists active and ended journeys and the timeline of that person only", async () => {
    const now = new Date("2026-11-06T09:00:00Z");
    const a = await makeAutomation(h.db, { slug: "panel-active", isMarketing: false, definition: def({ steps: [{ key: "s1", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: 60 } }] }) });
    const b = await makeAutomation(h.db, { slug: "panel-ended", isMarketing: false });
    const p = await makePerson(h.db);
    const other = await makePerson(h.db);
    await enrolInto(h.db, a.id, p.id, { now });
    const endedId = await enrolInto(h.db, b.id, p.id, { now });
    await endEnrolment(h.db as unknown as Tx, endedId, "exited", "manual", SYSTEM);
    await enrolInto(h.db, b.id, other.id, { now });
    const html = await render(p.id);
    expect(html).toContain('data-testid="automation-panel-active"');
    expect(html).toContain('data-testid="automation-panel-ended"');
    expect(html).toContain('data-outcome="entered"');
    expect(html).toContain('data-outcome="exited"');
    expect(html).toContain("s1");
    expect((html.match(/data-enrolment-id=/g) ?? []).length).toBe(2);
  });
});

/**
 * email-P7: the person-page email history (email spec rule 63, section 5). Every message to the
 * person, newest first, 50 per page; addresses masked without `persons.read`; test sends left
 * out; the `PersonEmailHistory` server component crm renders shows reachability per purpose, the
 * empty state, and Resend only for transactional messages and staff with `persons.write`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const { resetRuntime } = await import("@/lib/testing");
const { PersonEmailHistory } = await import("./ui/PersonEmailHistory");
const { listPersonEmailHistory, PERSON_HISTORY_PAGE_SIZE } = await import("./queries");
const { consent, personWith } = await import("./email-p3.fixtures");
const { insertMessages, templateVersion } = await import("./email-p7.fixtures");

let h: DbHandle;
let personId: string;
let ids: string[];

const base = new Date("2026-10-01T08:00:00Z");

beforeAll(async () => {
  h = await createTestDb();
  const person = await personWith(h.db, { email: "p7-history@example.com" });
  personId = person.id;
  await consent(h.db, personId, "newsletter");
  const { versionId } = await templateVersion(h.db, "transactional");
  // 55 messages, one minute apart; message i is created at base + i minutes.
  ids = await insertMessages(h.db, 55, { templateVersionId: versionId, kind: "transactional", purpose: null, fromDomain: "mail.beam.be", personId, toEmail: person.email }, (i) => ({
    createdAt: new Date(base.getTime() + i * 60_000),
    sentAt: new Date(base.getTime() + i * 60_000),
    status: "delivered",
    openedAt: i === 54 ? new Date(base.getTime() + 60 * 60_000) : null,
  }));
  await insertMessages(h.db, 1, { templateVersionId: versionId, kind: "test", purpose: null, fromDomain: "mail.beam.be", personId, toEmail: "staff@demo.beam.be", createdAt: new Date(base.getTime() + 100 * 60_000) });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("listPersonEmailHistory", () => {
  it("lists newest first, 50 per page, without test sends", async () => {
    const page1 = await listPersonEmailHistory(h.db, { personId });
    expect(page1.items).toHaveLength(PERSON_HISTORY_PAGE_SIZE);
    expect(page1.items[0]!.id).toBe(ids[54]);
    expect(page1.items[0]!.openedAt).not.toBeNull();
    expect(page1.items.map((m) => m.createdAt.getTime())).toEqual([...page1.items.map((m) => m.createdAt.getTime())].sort((a, b) => b - a));
    expect(page1.nextPage).toBe(2);
    const page2 = await listPersonEmailHistory(h.db, { personId, page: 2 });
    expect(page2.items.map((m) => m.id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
    expect(page2.nextPage).toBeNull();
    expect([...page1.items, ...page2.items].some((m) => m.kind === "test")).toBe(false);
  });

  it("masks the address (and hides the subject) without persons.read", async () => {
    const masked = await listPersonEmailHistory(h.db, { personId }, { unmasked: false });
    expect(masked.items[0]!.email).toBe("p***@example.com");
    expect(masked.items[0]!.subject).toBeNull();
    const open = await listPersonEmailHistory(h.db, { personId }, { unmasked: true });
    expect(open.items[0]!.email).toBe("p7-history@example.com");
  });
});

describe("PersonEmailHistory", () => {
  const render = async (props: { personId: string; canReadPersons: boolean; canWritePersons: boolean; canOpenMessages: boolean }) =>
    renderToStaticMarkup(await PersonEmailHistory({ ...props, db: h.db, locale: "en" }));

  it("renders the rows, reachability and Resend for staff with persons.write", async () => {
    const html = await render({ personId, canReadPersons: true, canWritePersons: true, canOpenMessages: true });
    expect(html).toContain('data-testid="person-email-history"');
    expect(html.match(/data-message-id=/g)).toHaveLength(50);
    expect(html).toContain('data-purpose="newsletter" data-reachable="true"');
    expect(html).toContain('data-testid="message-resend"');
    expect(html).toContain(`/admin/email/messages/${ids[54]}`);
    expect(html).toContain(`/admin/email/messages?person=${personId}`);
  });

  it("hides Resend without persons.write and the message link without email.write; masks without persons.read", async () => {
    const html = await render({ personId, canReadPersons: false, canWritePersons: false, canOpenMessages: false });
    expect(html).not.toContain('data-testid="message-resend"');
    expect(html).not.toContain("/admin/email/messages/");
    expect(html).not.toContain("p7-history@example.com");
    expect(html).toContain("p***@example.com");
  });

  it("shows the empty state for a person without email", async () => {
    const other = await personWith(h.db, { email: "p7-history-empty@example.com" });
    const html = await render({ personId: other.id, canReadPersons: true, canWritePersons: true, canOpenMessages: true });
    expect(html).toContain('data-testid="person-email-empty"');
    expect(html).toContain("No emails sent to this person");
  });
});

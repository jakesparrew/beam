/**
 * email-P3: open and click tracking (email spec rules 50, 51; edge cases 14, 24), through the
 * route handlers and the tracking helpers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailMessages } from "@beam/db/schema";
import { newLinkToken } from "@beam/core/email";
import { setAppDb } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { GET as clickRoute } from "@/app/api/public/track/click/route";
import { GET as openRoute } from "@/app/api/public/track/open/route";
import { getTemplateInfo } from "../api";
import { blockTemplate, eventsOf, messageOf, personWith, timeline } from "../email-p3.fixtures";
import { applyTracking, uaFamily } from "./tracking";

let h: DbHandle;
let versionId: string;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await blockTemplate(h.db, { slug: "p3t-news", kind: "marketing", purpose: "newsletter" });
  versionId = (await getTemplateInfo(h.db, "p3t-news"))!.templateVersionId;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const LINKS = ["https://beam.be/nl/events/sauna-night", "https://beam.be/nl/account/shop/day-pass"];

async function marketingMessage(sentAt = new Date()) {
  const p = await personWith(h.db);
  const link = newLinkToken();
  const [row] = await h.db
    .insert(emailMessages)
    .values({
      personId: p.id,
      toEmail: p.email,
      kind: "automation",
      purpose: "newsletter",
      templateVersionId: versionId,
      fromDomain: "news.beam.be",
      locale: "nl-BE",
      idempotencyKey: `p3t:${link.hash.slice(0, 16)}`,
      status: "sent",
      sentAt,
      linkTokenHash: link.hash,
      links: LINKS,
    })
    .returning();
  return { id: row!.id, personId: p.id, token: link.token };
}

const open = (token: string, ua = "Mozilla/5.0 (Windows NT 10.0) Thunderbird") =>
  openRoute(new Request(`https://beam.be/api/public/track/open?t=${token}`, { headers: { "user-agent": ua } }));
const click = (token: string, index: string) => clickRoute(new Request(`https://beam.be/api/public/track/click?t=${token}&l=${index}`));

describe("open pixel", () => {
  it("returns the GIF, sets opened_at once and appends an event per hit", async () => {
    const m = await marketingMessage();
    const first = await open(m.token);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/gif");
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect((await first.arrayBuffer()).byteLength).toBe(43);
    const openedAt = (await messageOf(h.db, m.id)).openedAt;
    expect(openedAt).not.toBeNull();
    await open(m.token, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    expect((await messageOf(h.db, m.id)).openedAt?.getTime()).toBe(openedAt!.getTime());
    const events = (await eventsOf(h.db, m.id)).filter((e) => e.type === "opened");
    expect(events.map((e) => e.payload)).toEqual([{ ua_family: "other" }, { ua_family: "apple_mpp" }]);
    expect(await timeline(h.db, m.personId, "email.opened")).toHaveLength(1);
  });

  it("a forged token still answers the GIF and records nothing", async () => {
    const res = await open(newLinkToken().token);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(43);
  });

  it("after 365 days the pixel records nothing", async () => {
    const m = await marketingMessage(new Date(Date.now() - 400 * 86_400_000));
    await open(m.token);
    expect(await eventsOf(h.db, m.id)).toHaveLength(0);
  });
});

describe("click redirect", () => {
  it("redirects to links[i], records the click and also sets opened_at", async () => {
    const m = await marketingMessage();
    const res = await click(m.token, "1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(LINKS[1]);
    const row = await messageOf(h.db, m.id);
    expect(row.clickedAt).not.toBeNull();
    expect(row.openedAt).not.toBeNull();
    const [event] = (await eventsOf(h.db, m.id)).filter((e) => e.type === "clicked");
    expect(event).toMatchObject({ url: LINKS[1], linkIndex: 1, source: "tracking" });
    expect(await timeline(h.db, m.personId, "email.clicked")).toHaveLength(1);
    await click(m.token, "1");
    expect(await timeline(h.db, m.personId, "email.clicked")).toHaveLength(1);
  });

  it("a forged token and a bad index redirect home and record nothing", async () => {
    const m = await marketingMessage();
    const forged = await click(newLinkToken().token, "0");
    expect(forged.status).toBe(302);
    expect(forged.headers.get("location")).toBe("https://beam.be/nl");
    for (const bad of ["2", "-1", "x", "99999"]) {
      const res = await click(m.token, bad);
      expect(res.headers.get("location")).toBe("https://beam.be/nl");
    }
    expect(await eventsOf(h.db, m.id)).toHaveLength(0);
  });
});

describe("applyTracking and uaFamily", () => {
  it("rewrites http(s) links except crm's token links and appends the pixel", () => {
    const token = newLinkToken().token;
    const html = `<html><body><a href="https://beam.be/a?x=1&amp;y=2">A</a><a href="https://beam.be/nl/preferences/${token}">P</a><a href="mailto:x@example.com">M</a></body></html>`;
    const out = applyTracking(html, token, "https://beam.be");
    expect(out.links).toEqual(["https://beam.be/a?x=1&y=2"]);
    expect(out.html).toContain(`href="https://beam.be/api/public/track/click?t=${token}&amp;l=0"`);
    expect(out.html).toContain(`/preferences/${token}"`);
    expect(out.html).toContain("mailto:x@example.com");
    expect(out.html).toMatch(/<img src="https:\/\/beam\.be\/api\/public\/track\/open\?t=[^"]+" width="1" height="1" alt=""[^>]*\/><\/body>/);
  });

  it("classifies privacy proxies", () => {
    expect(uaFamily("Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)")).toBe("gmail_proxy");
    expect(uaFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("apple_mpp");
    expect(uaFamily(null)).toBe("other");
  });
});

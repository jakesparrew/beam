/**
 * Open and click tracking (email spec rules 50, 51, 53; edge cases 14, 15, 16, 24).
 *
 * - `applyTracking(html, token)`: marketing messages only. Every absolute `http(s)` link except
 *   crm's preference and unsubscribe links (they carry the token already) is rewritten to
 *   `/api/public/track/click?t=<token>&l=<index>`, and a 1x1 pixel `/api/public/track/open?t=`
 *   is appended. `links[index]` is the original target; the click route redirects only there.
 * - `recordOpen` / `recordClick`: the routes' work. Every hit within 365 days of `sent_at`
 *   appends an `email_events` row (source `tracking`, payload `{ ua_family }` only, no IP);
 *   `opened_at` and `clicked_at` keep the first; a click also sets `opened_at`. Timeline events:
 *   `email.opened` on the first open, `email.clicked` on the first click per link index. A forged
 *   token or a bad index records nothing and redirects to the BEAM home page of the locale.
 */
import type { Db, DbOrTx } from "@beam/db";
import { emailEvents, emailMessages } from "@beam/db/schema";
import { hashLinkToken, isLinkTokenShape, parseLinkIndex } from "@beam/core/email";
import { isLocale, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { and, eq, isNotNull, ne, sql } from "@/lib/ctx";
import { recordEvent } from "@/lib/events";
import { appOrigin } from "./merge-fields";

export const TRACKING_WINDOW_DAYS = 365;

/** The 43-byte transparent GIF of the open pixel. */
export const TRANSPARENT_GIF = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));

export type UaFamily = "apple_mpp" | "gmail_proxy" | "other";

/** Privacy proxies (edge case 16): Apple Mail Privacy Protection and the Gmail image proxy. */
export function uaFamily(userAgent: string | null | undefined): UaFamily {
  const ua = userAgent ?? "";
  if (/GoogleImageProxy/i.test(ua)) return "gmail_proxy";
  if (/^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X [\d_]+\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)$/.test(ua.trim())) return "apple_mpp";
  return "other";
}

const decode = (v: string) => v.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _m);
const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function trackingUrls(token: string, origin: string = appOrigin()): { open: string; click: (index: number) => string } {
  const t = encodeURIComponent(token);
  return { open: `${origin}/api/public/track/open?t=${t}`, click: (index) => `${origin}/api/public/track/click?t=${t}&l=${index}` };
}

export function applyTracking(html: string, token: string, origin: string = appOrigin()): { html: string; links: string[] } {
  const links: string[] = [];
  const urls = trackingUrls(token, origin);
  const tracked = html.replace(/(<a\b[^>]*?\shref\s*=\s*)("([^"]*)"|'([^']*)')/gi, (whole, prefix: string, _q, dq?: string, sq?: string) => {
    const href = decode((dq ?? sq ?? "").trim());
    if (!/^https?:\/\//i.test(href) || href.includes(token) || href.includes(encodeURIComponent(token))) return whole;
    let index = links.indexOf(href);
    if (index === -1) index = links.push(href) - 1;
    return `${prefix}"${attr(urls.click(index))}"`;
  });
  const pixel = `<img src="${attr(urls.open)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
  const withPixel = /<\/body>/i.test(tracked) ? tracked.replace(/<\/body>/i, `${pixel}</body>`) : `${tracked}${pixel}`;
  return { html: withPixel, links };
}

type TrackedMessage = { id: string; personId: string | null; locale: string; links: string[] | null; sentAt: Date | null; openedAt: Date | null; clickedAt: Date | null };

async function findMessage(tx: DbOrTx, token: string | null | undefined): Promise<TrackedMessage | null> {
  if (!isLinkTokenShape(token)) return null;
  const [row] = await tx
    .select({
      id: emailMessages.id,
      personId: emailMessages.personId,
      locale: emailMessages.locale,
      links: emailMessages.links,
      sentAt: emailMessages.sentAt,
      openedAt: emailMessages.openedAt,
      clickedAt: emailMessages.clickedAt,
    })
    .from(emailMessages)
    .where(and(eq(emailMessages.linkTokenHash, hashLinkToken(token)), ne(emailMessages.kind, "test"), isNotNull(emailMessages.purpose)))
    .for("update");
  return row ?? null;
}

const withinWindow = (m: TrackedMessage, now: Date) => !!m.sentAt && now.getTime() - m.sentAt.getTime() <= TRACKING_WINDOW_DAYS * 86_400_000;

export function homeUrl(locale: Locale | string | null | undefined): string {
  const l: Locale = isLocale(locale) ? locale : "nl-BE";
  return `https://beam.be/${URL_SEGMENT[l]}`;
}

const PUBLIC_ACTOR = { kind: "system", id: null } as const;

/** The open pixel: records the open (marketing messages only); the route always answers the GIF. */
export async function recordOpen(db: Db, input: { token: string | null; userAgent: string | null; now?: Date }): Promise<{ recorded: boolean }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const m = await findMessage(tx, input.token);
    if (!m || !withinWindow(m, now)) return { recorded: false };
    await tx.insert(emailEvents).values({ emailMessageId: m.id, type: "opened", source: "tracking", payload: { ua_family: uaFamily(input.userAgent) }, occurredAt: now });
    const first = !m.openedAt;
    await tx
      .update(emailMessages)
      .set({ openedAt: sql`coalesce(${emailMessages.openedAt}, ${now})`, lastEventAt: sql`greatest(${emailMessages.lastEventAt}, ${now})`, updatedAt: now })
      .where(eq(emailMessages.id, m.id));
    if (first && m.personId) {
      await recordEvent(tx, PUBLIC_ACTOR, { kind: "email.opened", personId: m.personId, data: {}, ref: { type: "email_message", id: m.id }, dedupeKey: `email:${m.id}:opened` });
    }
    return { recorded: true };
  });
}

/** The click redirect target: `links[index]` of the message, or the home page of its locale. */
export async function recordClick(
  db: Db,
  input: { token: string | null; index: string | null; userAgent: string | null; now?: Date },
): Promise<{ location: string; recorded: boolean }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const m = await findMessage(tx, input.token);
    if (!m) return { location: homeUrl(null), recorded: false };
    const links = m.links ?? [];
    const index = parseLinkIndex(input.index, links.length);
    if (index === null) return { location: homeUrl(m.locale), recorded: false };
    const url = links[index]!;
    if (!withinWindow(m, now)) return { location: url, recorded: false };
    await tx.insert(emailEvents).values({
      emailMessageId: m.id,
      type: "clicked",
      source: "tracking",
      url,
      linkIndex: index,
      payload: { ua_family: uaFamily(input.userAgent) },
      occurredAt: now,
    });
    await tx
      .update(emailMessages)
      .set({
        clickedAt: sql`coalesce(${emailMessages.clickedAt}, ${now})`,
        openedAt: sql`coalesce(${emailMessages.openedAt}, ${now})`,
        lastEventAt: sql`greatest(${emailMessages.lastEventAt}, ${now})`,
        updatedAt: now,
      })
      .where(eq(emailMessages.id, m.id));
    if (m.personId) {
      if (!m.openedAt) {
        await recordEvent(tx, PUBLIC_ACTOR, { kind: "email.opened", personId: m.personId, data: {}, ref: { type: "email_message", id: m.id }, dedupeKey: `email:${m.id}:opened` });
      }
      await recordEvent(tx, PUBLIC_ACTOR, {
        kind: "email.clicked",
        personId: m.personId,
        data: { link_index: index, url },
        ref: { type: "email_message", id: m.id },
        dedupeKey: `email:${m.id}:clicked:${index}`,
      });
    }
    return { location: url, recorded: true };
  });
}

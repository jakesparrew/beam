/**
 * webinar's demo seed (runbook 6.3, webinar spec 4.8; webinar-P3), run by
 * `apps/web/scripts/seed-demo.ts` in `after` order. Facade read by `pnpm gen:indexes`.
 *
 * - The marketing template `webinar-follow-up` through `email.seedTemplate` (the same writer as
 *   the `defaults` profile in `packages/db/src/seed/webinar.ts`; an existing slug is untouched).
 * - Outside production, one demo webinar of each mode with a poll, a CTA and fake YouTube ids:
 *   `demo-webinar-live`, `demo-webinar-simulive` (both published once booking's
 *   `upsertWebinarSession` gives them their event session; drafts while it is not available) and
 *   `demo-webinar-on-demand` (published, no session). Slugs are fixed, so a second run adds
 *   nothing.
 */
import type { Tx } from "@beam/db";
import { users, webinarCtas, webinarPolls, webinars } from "@beam/db/schema";
import { seedWebinarRows } from "@beam/db/seed/webinar";
import { NotImplementedError } from "@beam/core/errors";
import { and, asc, eq, inArray } from "@/lib/ctx";
import type { SeedCtx } from "@/scripts/seed-demo";
import { seedTemplate } from "@/modules/email/api";
import { upsertWebinarSession } from "@/modules/booking/api";

/** Valid 11-character ids that are not real broadcasts. */
const DEMO_VIDEO_ID = "beamDemo001";

const TITLE = {
  live: { "nl-BE": "Beter slapen, meer energie", "fr-BE": "Mieux dormir, plus d’énergie", en: "Sleep better, more energy" },
  simulive: { "nl-BE": "Herstel na het sporten", "fr-BE": "La récupération après le sport", en: "Recovery after exercise" },
  on_demand: { "nl-BE": "Kennismaking met BEAM", "fr-BE": "Découvrir BEAM", en: "Getting to know BEAM" },
} as const;

const DESCRIPTION = {
  "nl-BE": "Een gratis online sessie van het BEAM-team, met tijd voor je vragen.",
  "fr-BE": "Une session en ligne gratuite de l’équipe BEAM, avec du temps pour vos questions.",
  en: "A free online session by the BEAM team, with time for your questions.",
};

async function ownerOf(s: SeedCtx): Promise<string | null> {
  for (const role of ["owner", "marketing", "technical_admin"]) {
    const id = s.ids.get(`platform.user.${role}`);
    if (id) return id;
  }
  const [u] = await s.db.select({ id: users.id }).from(users).where(and(eq(users.audience, "staff"), eq(users.status, "active"))).orderBy(asc(users.createdAt)).limit(1);
  return u?.id ?? null;
}

async function seedDemoWebinars(s: SeedCtx): Promise<void> {
  const slugs = ["demo-webinar-live", "demo-webinar-simulive", "demo-webinar-on-demand"];
  const existing = new Set((await s.db.select({ slug: webinars.slug }).from(webinars).where(inArray(webinars.slug, slugs))).map((r) => r.slug));
  const owner = await ownerOf(s);
  if (!owner) return;
  const day = 86_400_000;
  const at = (days: number, hourUtc: number) => new Date(s.now.getTime() + days * day + hourUtc * 3_600_000);
  const plans = [
    { slug: "demo-webinar-live", mode: "live" as const, startsAt: at(7, 18), extra: { youtubeVideoId: DEMO_VIDEO_ID } },
    { slug: "demo-webinar-simulive", mode: "simulive" as const, startsAt: at(3, 18), extra: { recordingVideoId: DEMO_VIDEO_ID, durationSec: 2700 } },
    { slug: "demo-webinar-on-demand", mode: "on_demand" as const, startsAt: null, extra: { recordingVideoId: DEMO_VIDEO_ID, durationSec: 1800 } },
  ];
  for (const p of plans) {
    if (existing.has(p.slug)) continue;
    const [w] = await s.db
      .insert(webinars)
      .values({ slug: p.slug, mode: p.mode, title: TITLE[p.mode], description: DESCRIPTION, startsAt: p.startsAt, ownerUserId: owner, createdByUserId: owner, ...p.extra })
      .onConflictDoNothing({ target: webinars.slug })
      .returning();
    if (!w) continue;
    await s.db.insert(webinarPolls).values({
      webinarId: w.id,
      key: "sleep_quality",
      question: { "nl-BE": "Hoe slaap je meestal?", "fr-BE": "Comment dormez-vous en général ?", en: "How do you usually sleep?" },
      options: [
        { key: "well", label: { "nl-BE": "Goed", "fr-BE": "Bien", en: "Well" } },
        { key: "poorly", label: { "nl-BE": "Slecht", "fr-BE": "Mal", en: "Poorly" } },
      ],
      showAtSec: 600,
    });
    await s.db.insert(webinarCtas).values({
      webinarId: w.id,
      key: "book_intro",
      label: { "nl-BE": "Boek een kennismaking", "fr-BE": "Réservez une découverte", en: "Book an introduction" },
      url: "https://beam.example.com/nl/booking",
      showAtSec: 1200,
    });
    let sessionId: string | null = null;
    if (p.startsAt) {
      try {
        const end = new Date(p.startsAt.getTime() + (p.extra.durationSec ?? 3600) * 1000);
        sessionId = (await upsertWebinarSession(s.db as Tx, s.ctx, { webinarId: w.id, title: TITLE[p.mode], startsAt: p.startsAt, endsAt: end })).sessionId;
      } catch (error) {
        if (!(error instanceof NotImplementedError)) throw error;
        continue; // stays a draft until booking can link the event session
      }
    }
    await s.db.update(webinars).set({ status: "published", publishedAt: s.now, sessionId, updatedAt: s.now }).where(eq(webinars.id, w.id));
  }
}

export const seed = {
  after: ["ops"],
  run: async (s: SeedCtx): Promise<void> => {
    await seedWebinarRows(s.db, { seedTemplate: (db, input) => seedTemplate(db as Tx, input) });
    if (process.env.VERCEL_ENV === "production") return;
    await seedDemoWebinars(s);
  },
};

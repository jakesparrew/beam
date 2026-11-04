/**
 * Test fixtures of site-P3 (BS-23): staff sessions with chosen permissions, publishable content,
 * media rows and a 1x1 PNG. Each test file mocks `next/headers` with its own cookie jar and
 * passes it here.
 */
import { randomUUID } from "node:crypto";
import type { Db, DbOrTx } from "@beam/db";
import { files, jobs, mediaAssets, roles } from "@beam/db/schema";
import { makeUser } from "@beam/db/testing";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { paragraphDoc, type Block, type PageSeo } from "@beam/core/site";
import { createAuthSession, SESSION_COOKIE } from "@/lib/auth";
import { eq } from "@/lib/ctx";

/** Signs in a `marketing` staff user whose role holds exactly `permissions`. */
export async function staffSession(db: Db, jar: Map<string, string>, permissions: string[]) {
  const user = await makeUser(db, { roleKey: "marketing" });
  await db.update(roles).set({ permissions }).where(eq(roles.key, "marketing"));
  const { token } = await createAuthSession(db, { userId: user.id, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

export const ALL = [...LOCALES] as Locale[];
export const slug = (p = "p") => `${p}-${randomUUID().slice(0, 8)}`;

export function textBlock(text = "Welkom bij BEAM."): Block {
  return { id: randomUUID(), type: "rich_text", doc: paragraphDoc(text) } as Block;
}

const seoFor = (l: Locale): PageSeo => ({ title: `BEAM ${l}`, description: `A description that is long enough for search engines in ${l}, really.` });

/** saveDraft input fields that pass every publish check for `locales` (paths derived from `base`). */
export function publishable(base: string, locales: Locale[] = ALL, extra: { blocks?: (l: Locale) => Block[] } = {}) {
  const title: LocalizedText = {};
  const paths: Partial<Record<Locale, string>> = {};
  const blocks: Partial<Record<Locale, Block[]>> = {};
  const seo: Partial<Record<Locale, PageSeo>> = {};
  for (const l of locales) {
    title[l] = `Title ${base} ${l}`;
    paths[l] = `${base}-${l.slice(0, 2).toLowerCase()}`;
    blocks[l] = extra.blocks ? extra.blocks(l) : [textBlock()];
    seo[l] = seoFor(l);
  }
  return { title, paths, blocks, seo, locales, isMaterialChange: false };
}

/** A 1x1 transparent PNG. */
export const PNG_1X1 = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
);

/** A media asset with a stored file (alt per locale, or decorative). */
export async function makeMedia(db: DbOrTx, alt: LocalizedText = { "nl-BE": "Sauna", "fr-BE": "Sauna", en: "Sauna" }, isDecorative = false) {
  const [file] = await db
    .insert(files)
    .values({ kind: "image", name: "test.png", mime: "image/png", sizeBytes: PNG_1X1.byteLength, bytes: PNG_1X1, sha256: randomUUID(), isPublic: true })
    .returning({ id: files.id });
  const [media] = await db.insert(mediaAssets).values({ fileId: file!.id, alt, isDecorative, width: 1, height: 1 }).returning();
  return media!;
}

export function queued(db: DbOrTx, kind: string) {
  return db.select().from(jobs).where(eq(jobs.kind, kind)).orderBy(jobs.createdAt);
}

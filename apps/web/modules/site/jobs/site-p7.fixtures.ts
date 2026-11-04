/**
 * Test fixtures of site-P7 (BS-23): an uploaded WXR import with its importer and file, the sample
 * export, and the media URLs of the sample with a WordPress fake that serves them.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DbOrTx } from "@beam/db";
import { files, wordpressImports } from "@beam/db/schema";
import { makeUser } from "@beam/db/testing";
import { createWordpressFake, fakePng, type FakeWordpressFile } from "@beam/integrations/wordpress";

export const SAMPLE_ORIGIN = "https://www.beam.be";
export const SAMPLE_XML = readFileSync(new URL("../server/wordpress/__fixtures__/beam-sample.wxr.xml", import.meta.url), "utf8");

const U = `${SAMPLE_ORIGIN}/wp-content/uploads/2024/01`;
/** The six attachment URLs of the sample (one on the CDN). */
export const SAMPLE_MEDIA: Record<string, FakeWordpressFile> = {
  [`${U}/pool.jpg`]: { mime: "image/png", bytes: fakePng(1200, 800) },
  [`${U}/lounge.png`]: { mime: "image/png", bytes: fakePng(800, 600) },
  [`${U}/sauna.jpg`]: { mime: "image/png", bytes: fakePng(640, 480) },
  [`${U}/new-sauna.jpg`]: { mime: "image/png", bytes: fakePng(640, 480) },
  [`${U}/logo.gif`]: { mime: "image/png", bytes: fakePng(100, 100) },
  ["https://cdn.beam.be/wp-content/uploads/2024/03/opening.jpg"]: { mime: "image/png", bytes: fakePng(1024, 768) },
};

export function sampleFake(overrides: Record<string, FakeWordpressFile> = {}) {
  return createWordpressFake({ ...SAMPLE_MEDIA, ...overrides });
}

/** An `uploaded` import of `xml` by a fresh staff user. */
export async function makeImport(db: DbOrTx, opts: { xml?: string; status?: "uploaded" | "parsed"; siteOrigin?: string } = {}) {
  const user = await makeUser(db);
  const bytes = new TextEncoder().encode(opts.xml ?? SAMPLE_XML);
  const [file] = await db
    .insert(files)
    .values({ kind: "import", name: "beam.wxr.xml", mime: "application/xml", sizeBytes: bytes.byteLength, bytes, sha256: createHash("sha256").update(randomUUID()).digest("hex") })
    .returning({ id: files.id });
  const [imp] = await db
    .insert(wordpressImports)
    .values({ fileId: file!.id, siteOrigin: opts.siteOrigin ?? SAMPLE_ORIGIN, status: opts.status ?? "uploaded", createdByUserId: user.id })
    .returning();
  return { importId: imp!.id, userId: user.id, fileId: file!.id };
}

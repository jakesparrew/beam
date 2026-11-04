"use server";
/**
 * site server actions, media library (site spec section 4, `media_assets`; site-P3): uploadMedia,
 * updateMedia, deleteMedia (`site.edit`). Uploads are JPEG, PNG, WebP or GIF up to 10 MB; the type
 * and the dimensions come from the file header (`imageSize`), so SVG, AVIF and renamed files are
 * refused. Bytes are stored through platform's `storeFile(ctx, { kind: 'image', isPublic: true })`.
 * An image used by a draft, a proposal or a live version cannot be deleted (`conflict`).
 */
import { z } from "zod";
import { files, mediaAssets } from "@beam/db/schema";
import { LocalizedTextSchema } from "@beam/core/i18n";
import { imageSize } from "@beam/core/site";
import { action, type ActionResult } from "@/lib/action";
import { ConflictError, eq, NotFoundError, ValidationError } from "@/lib/ctx";
import { IMAGE_MIMES, MAX_FILE_BYTES, storeFile } from "@/lib/files";
import { getSiteSettings } from "../server/settings";
import { MEDIA_TAGS, revalidateSite } from "../server/cache";
import { versionsUsingMedia } from "../server/refs";

const isBlob = (v: unknown): v is Blob => typeof Blob !== "undefined" && v instanceof Blob;

function parseJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Accepts `FormData { file, alt (JSON LocalizedText), isDecorative ('true'|'false') }` or a plain object. */
const UploadMediaInput = z.preprocess(
  (raw) =>
    typeof FormData !== "undefined" && raw instanceof FormData
      ? { file: raw.get("file"), alt: parseJson(raw.get("alt")) ?? {}, isDecorative: raw.get("isDecorative") === "true" || raw.get("isDecorative") === "on" }
      : raw,
  z.object({
    file: z.custom<Blob>(isBlob, { message: "file required" }),
    alt: LocalizedTextSchema.default({}),
    isDecorative: z.boolean().default(false),
  }),
);

const uploadImpl = action(
  { name: "site.media.upload", audience: "staff", permission: "site.edit", input: UploadMediaInput },
  async (ctx, input): Promise<{ mediaId: string; fileId: string }> => {
    const file = input.file;
    if (file.size > MAX_FILE_BYTES) throw new ValidationError("file_too_large", { file: "too_large" });
    const declared = file.type || "application/octet-stream";
    if (!(IMAGE_MIMES as readonly string[]).includes(declared)) throw new ValidationError("type_not_allowed", { file: "type_not_allowed" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const size = imageSize(bytes);
    if (!size || size.mime !== declared) throw new ValidationError("not_an_image", { file: "not_an_image" });
    const name = (file as Blob & { name?: string }).name || `image.${size.mime.split("/")[1]}`;
    const stored = await storeFile(ctx, { kind: "image", name, mime: size.mime, bytes, isPublic: true });
    const [row] = await ctx.tx
      .insert(mediaAssets)
      .values({
        fileId: stored.fileId,
        alt: input.alt,
        isDecorative: input.isDecorative,
        width: size.width,
        height: size.height,
        source: "upload",
        uploadedByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      })
      .returning({ id: mediaAssets.id });
    await ctx.audit({ action: "site.media.upload", entityType: "media_asset", entityId: row!.id, newValue: { fileId: stored.fileId, name, mime: size.mime, width: size.width, height: size.height, sizeBytes: bytes.byteLength } });
    return { mediaId: row!.id, fileId: stored.fileId };
  },
);

const UpdateMediaInput = z.object({
  mediaId: z.string().uuid(),
  alt: LocalizedTextSchema,
  isDecorative: z.boolean(),
  caption: LocalizedTextSchema.nullish(),
  credit: z.string().max(200).nullish(),
});

const updateImpl = action(
  { name: "site.media.update", audience: "staff", permission: "site.edit", input: UpdateMediaInput },
  async (ctx, input): Promise<{ ok: true }> => {
    const [row] = await ctx.tx.select().from(mediaAssets).where(eq(mediaAssets.id, input.mediaId)).for("update");
    if (!row) throw new NotFoundError("media_not_found");
    const next = { alt: input.alt, isDecorative: input.isDecorative, caption: input.caption ?? null, credit: input.credit?.trim() || null };
    await ctx.tx.update(mediaAssets).set({ ...next, updatedAt: ctx.now }).where(eq(mediaAssets.id, row.id));
    await ctx.audit({ action: "site.media.update", entityType: "media_asset", entityId: row.id, oldValue: { alt: row.alt, isDecorative: row.isDecorative, caption: row.caption, credit: row.credit }, newValue: next });
    return { ok: true };
  },
);

const deleteImpl = action(
  { name: "site.media.delete", audience: "staff", permission: "site.edit", input: z.object({ mediaId: z.string().uuid() }) },
  async (ctx, input): Promise<{ ok: true }> => {
    const [row] = await ctx.tx.select().from(mediaAssets).where(eq(mediaAssets.id, input.mediaId)).for("update");
    if (!row) throw new NotFoundError("media_not_found");
    const users = await versionsUsingMedia(ctx.tx, row.id);
    if (users.length) throw new ConflictError("media_in_use");
    const settings = await getSiteSettings(ctx.tx);
    if (settings.default_og_image_media_id === row.id) throw new ConflictError("media_in_use");
    try {
      await ctx.tx.delete(mediaAssets).where(eq(mediaAssets.id, row.id));
    } catch (error) {
      // A historic version's cover or an import item still references it (foreign key).
      const e = error as { code?: string; cause?: { code?: string } };
      if (e.code === "23503" || e.cause?.code === "23503") throw new ConflictError("media_in_use");
      throw error;
    }
    // The bytes go with platform's expired-file purge (no row references the file any more).
    await ctx.tx.update(files).set({ expiresAt: ctx.now }).where(eq(files.id, row.fileId));
    await ctx.audit({ action: "site.media.delete", entityType: "media_asset", entityId: row.id, oldValue: { fileId: row.fileId, alt: row.alt, width: row.width, height: row.height } });
    return { ok: true };
  },
);

export async function uploadMedia(raw: unknown): Promise<ActionResult<{ mediaId: string; fileId: string }>> {
  return uploadImpl(raw);
}

export async function updateMedia(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  const result = await updateImpl(raw);
  if (result.ok) revalidateSite(MEDIA_TAGS);
  return result;
}

/** Deletes an unused image; `conflict` while a draft, proposal, live version or the default OG image uses it. */
export async function deleteMedia(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  return deleteImpl(raw);
}

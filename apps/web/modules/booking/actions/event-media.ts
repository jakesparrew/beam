"use server";
/**
 * booking server actions, area `event-media` (owner requirements 4 and 5): the artwork of an
 * event or webinar (a public image) and its presentations and supporting materials (private
 * `material` files, in `sessions.material_file_ids`), released to the people booked with
 * `setMaterialsReleased`. Staff with `bookings.override`, like the other session edits.
 */
import { z } from "zod";
import { sessions } from "@beam/db/schema";
import { action } from "@/lib/action";
import { IMAGE_MIMES, MAX_FILE_BYTES, storeFile } from "@/lib/files";
import { ValidationError, eq, sql, type Ctx } from "@/lib/ctx";
import { lockSession } from "../server/book";

const MAX_MATERIALS = 20;
const IdInput = z.object({ id: z.uuid() });
const MaterialInput = z.object({ id: z.uuid(), fileId: z.uuid() });
const ReleaseInput = z.object({ id: z.uuid(), released: z.boolean() });

/** The session id and the uploaded file of a form (`sessionId`, `file`). */
function upload(form: FormData): { sessionId: string; file: Blob; name: string } {
  const sessionId = z.uuid().safeParse(form.get("sessionId"));
  const file = form.get("file");
  if (!sessionId.success) throw new ValidationError("validation", { sessionId: "required" });
  if (!(file instanceof Blob) || file.size === 0) throw new ValidationError("validation", { file: "required" });
  if (file.size > MAX_FILE_BYTES) throw new ValidationError("file_too_large", { file: "too_large" });
  return { sessionId: sessionId.data, file, name: (file as Blob & { name?: string }).name || "file" };
}

async function touch(ctx: Ctx, id: string, values: Partial<typeof sessions.$inferInsert>): Promise<void> {
  await ctx.tx
    .update(sessions)
    .set({ ...values, updatedAt: sql`now()` })
    .where(eq(sessions.id, id));
}

/** Sets (or replaces) the artwork: png, jpeg, webp or gif, at most 10 MB, served publicly. */
export const uploadSessionImage = action(
  { name: "booking.upload_session_image", audience: "staff", permission: "bookings.override", input: z.instanceof(FormData), audit: { entityType: "session", entityId: (_i, o: { sessionId: string; fileId: string }) => o.sessionId } },
  async (ctx, form): Promise<{ sessionId: string; fileId: string }> => {
    const { sessionId, file, name } = upload(form);
    if (!(IMAGE_MIMES as readonly string[]).includes(file.type)) throw new ValidationError("image_type_not_allowed", { file: "type_not_allowed" });
    await lockSession(ctx.tx, sessionId);
    const { fileId } = await storeFile(ctx, { kind: "image", name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()), isPublic: true });
    await touch(ctx, sessionId, { imageFileId: fileId });
    return { sessionId, fileId };
  },
);

export const removeSessionImage = action(
  { name: "booking.remove_session_image", audience: "staff", permission: "bookings.override", input: IdInput, audit: { entityType: "session", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ id: string }> => {
    await lockSession(ctx.tx, input.id);
    await touch(ctx, input.id, { imageFileId: null });
    return { id: input.id };
  },
);

/** Adds a presentation or supporting material (any type but SVG, at most 10 MB, at most 20 per session). */
export const addSessionMaterial = action(
  { name: "booking.add_session_material", audience: "staff", permission: "bookings.override", input: z.instanceof(FormData), audit: { entityType: "session", entityId: (_i, o: { sessionId: string; fileId: string }) => o.sessionId } },
  async (ctx, form): Promise<{ sessionId: string; fileId: string }> => {
    const { sessionId, file, name } = upload(form);
    const session = await lockSession(ctx.tx, sessionId);
    if (session.materialFileIds.length >= MAX_MATERIALS) throw new ValidationError("validation", { file: "too_many" });
    const { fileId } = await storeFile(ctx, { kind: "material", name, mime: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
    await touch(ctx, sessionId, { materialFileIds: [...session.materialFileIds, fileId] });
    return { sessionId, fileId };
  },
);

export const removeSessionMaterial = action(
  { name: "booking.remove_session_material", audience: "staff", permission: "bookings.override", input: MaterialInput, audit: { entityType: "session", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ id: string }> => {
    const session = await lockSession(ctx.tx, input.id);
    await touch(ctx, input.id, { materialFileIds: session.materialFileIds.filter((f) => f !== input.fileId) });
    return { id: input.id };
  },
);

/** Shows (or hides again) the materials to the people booked, in the portal. */
export const setMaterialsReleased = action(
  { name: "booking.set_materials_released", audience: "staff", permission: "bookings.override", input: ReleaseInput, audit: { entityType: "session", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ id: string; releasedAt: Date | null }> => {
    const session = await lockSession(ctx.tx, input.id);
    const releasedAt = input.released ? (session.materialsReleasedAt ?? ctx.now) : null;
    await touch(ctx, input.id, { materialsReleasedAt: releasedAt });
    return { id: input.id, releasedAt };
  },
);

/**
 * `POST /admin/imports/upload` (ops spec 4.3, rule 42): one part of a chunked CSV upload,
 * multipart `{ part: Blob <= 3 MB, index, total, name }`, at most 17 parts (50 MB). Stores one
 * `files` row of kind `import` that expires after 2 days unless `createImport` attaches it.
 * Staff with `persons.write` only; `no-store`.
 */
import { IMPORT_MAX_PARTS, IMPORT_PART_BYTES } from "@beam/core/ops";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { createCtx, getAppDb } from "@/lib/ctx";
import { storeFile } from "@/modules/platform/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNATTACHED_TTL_MS = 2 * 86_400_000;

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff") return json(401, { error: "unauthorized" });
  if (!hasPermission(actor, "persons.write")) return json(403, { error: "forbidden" });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "validation" });
  }
  const part = form.get("part");
  const index = Number(form.get("index"));
  const total = Number(form.get("total"));
  const rawName = form.get("name");
  const name = (typeof rawName === "string" ? rawName : "import.csv").replace(/[/\\]/g, "_").slice(0, 160) || "import.csv";
  if (!(part instanceof Blob)) return json(400, { error: "validation", field: "part" });
  if (!Number.isInteger(total) || total < 1 || total > IMPORT_MAX_PARTS) return json(400, { error: "too_many_parts" });
  if (!Number.isInteger(index) || index < 0 || index >= total) return json(400, { error: "validation", field: "index" });
  if (part.size === 0 || part.size > IMPORT_PART_BYTES) return json(400, { error: "part_too_large" });

  const bytes = new Uint8Array(await part.arrayBuffer());
  const db = await getAppDb();
  const now = new Date();
  const { fileId } = await db.transaction(async (tx) => {
    const ctx = createCtx({ tx, actor, now });
    return storeFile(ctx, { kind: "import", name: `${name}.part${index + 1}of${total}`, mime: "text/csv", bytes, expiresAt: new Date(now.getTime() + UNATTACHED_TTL_MS) });
  });
  return json(200, { fileId });
}

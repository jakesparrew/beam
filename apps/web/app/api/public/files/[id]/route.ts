import { getAppDb } from "@/lib/ctx";
import { serveFile, SESSION_COOKIE_NAMES } from "@/lib/files";

// PL-46, PL-50: public images, signed tokens, or the session's permission; 404 otherwise.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const url = new URL(request.url);
  const header = request.headers.get("cookie");
  const sessionToken = SESSION_COOKIE_NAMES.map((n) => cookie(header, n)).find((v) => !!v) ?? null;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return serveFile(await getAppDb(), { fileId: id, token: url.searchParams.get("t"), sessionToken, ip });
}

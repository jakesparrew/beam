/** `POST /api/public/assistant/contact`: see `modules/assistant/server/public.ts`. */
import { handleContact } from "@/modules/assistant/server/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export function POST(req: Request): Promise<Response> {
  return handleContact(req);
}

/** `POST /api/public/assistant/event`: see `modules/assistant/server/public.ts`. */
import { handleEvent } from "@/modules/assistant/server/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export function POST(req: Request): Promise<Response> {
  return handleEvent(req);
}

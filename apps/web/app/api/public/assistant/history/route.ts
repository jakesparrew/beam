/** `POST /api/public/assistant/history`: see `modules/assistant/server/public.ts`. */
import { handleHistory } from "@/modules/assistant/server/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export function POST(req: Request): Promise<Response> {
  return handleHistory(req);
}

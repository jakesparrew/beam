/** `POST /api/public/assistant/chat`: see `modules/assistant/server/chat.ts`. */
import { handleChat } from "@/modules/assistant/server/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function POST(req: Request): Promise<Response> {
  return handleChat(req);
}

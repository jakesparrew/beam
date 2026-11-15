import { getSession } from "@/lib/auth";

// The public header's account link: who is signed in on this browser (first name and audience
// only, never email or ids), so cached public pages can show "Hi <name>" after load.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", "content-type": "application/json" };

export async function GET(): Promise<Response> {
  const session = await getSession().catch(() => null);
  if (!session) return new Response("null", { headers: NO_STORE });
  const first = (session.user.name ?? "").trim().split(/\s+/)[0] || session.user.email.split("@")[0]!;
  return new Response(JSON.stringify({ firstName: first, audience: session.audience === "staff" ? "staff" : "customer" }), { headers: NO_STORE });
}

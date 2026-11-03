/**
 * Auth.js routes (platform spec 4.4): the Email provider's callback for magic links and the
 * sign-out page. Database sessions; staff password sign-in does not pass through here (DR-11).
 */
import NextAuth from "next-auth";
import { buildAuthConfig } from "@/lib/auth-config";

export const runtime = "nodejs";

const { handlers } = NextAuth((request) => buildAuthConfig(request));

export const { GET, POST } = handlers;

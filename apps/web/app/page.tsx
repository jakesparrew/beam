import { redirect } from "next/navigation";

/** `/` is redirected by `proxy.ts` to the negotiated locale (PL-65); this is the fallback. */
export default function RootPage() {
  redirect("/nl" as never);
}

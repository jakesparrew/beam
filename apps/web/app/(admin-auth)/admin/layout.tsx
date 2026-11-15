import type { ReactNode } from "react";
import { adminAuthLocale, translator } from "@/lib/i18n";
import { AuthFrame } from "@/modules/platform/ui/auth-frame";

/** Staff sign-in pages (no shell): BEAM's space and logo beside the form. */
export default async function AdminAuthLayout({ children }: { children: ReactNode }) {
  const tr = translator(await adminAuthLocale());
  return (
    <AuthFrame tagline={tr("site.public.brand.tagline")} homeHref="/">
      <p className="text-xs font-semibold tracking-[0.25em] text-[#a0621e] uppercase">{tr("site.public.brand.backOffice")}</p>
      {children}
    </AuthFrame>
  );
}

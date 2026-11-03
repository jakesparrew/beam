import type { ReactNode } from "react";
import { headers } from "next/headers";
import { isLocale } from "@beam/core/i18n";
import { adminLocale, routeGroupOf } from "@/lib/i18n";
import "./globals.css";

export const metadata = {
  title: "BEAM",
  description: "BEAM Vitality Center",
};

/** `<html lang>` follows the locale (PL-90): the URL segment for site and portal, `users.locale` in the admin. */
async function documentLocale(): Promise<string> {
  const h = await headers();
  const fromProxy = h.get("x-beam-locale");
  if (isLocale(fromProxy)) return fromProxy;
  const pathname = (h.get("x-pathname") ?? "/").split("?")[0]!;
  if (routeGroupOf(pathname) === "admin") return adminLocale();
  return "nl-BE";
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={await documentLocale()}>
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}

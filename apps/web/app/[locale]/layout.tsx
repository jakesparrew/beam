import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { localeFromSegment } from "@beam/core/i18n";

/** Site and portal routes live under `/nl`, `/fr` and `/en` (PL-65); any other segment is a 404. */
export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!localeFromSegment(locale)) notFound();
  return children;
}

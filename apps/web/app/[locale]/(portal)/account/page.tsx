/**
 * The portal home `/[locale]/account` (site rule 47, section 5; site-P6). The portal layout has
 * already checked the customer session; the page reads it again for the person id (the layout
 * cannot pass props). Uncached and personal (`private, no-store` through the dynamic session
 * read); each card fails on its own, so the page always answers 200.
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { localeFromSegment } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { saveCheckin } from "@/modules/booking/actions";
import { getWellbeingJourney } from "@/modules/booking/api";
import { translator } from "@/lib/i18n";
import { getAccountHome } from "@/modules/site/queries";
import { AccountHome } from "@/modules/site/ui/portal/account-home";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (!locale) return {};
  return { title: translator(locale)("site.portal.nav.home"), robots: { index: false, follow: false } };
}

export default async function AccountHomePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ checkin?: string }> }) {
  const { locale: segment } = await params;
  const { checkin } = await searchParams;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const home = await getAccountHome(actor.personId, locale);
  const journey = await getWellbeingJourney(await getAppDb(), actor.personId).catch(() => null);
  const here = `/${segment}/account`;
  async function saveWellbeing(fd: FormData) {
    "use server";
    const num = (k: string) => {
      const v = fd.get(k);
      return typeof v === "string" && v ? Number(v) : undefined;
    };
    const bookingId = fd.get("bookingId");
    const note = fd.get("note");
    const res = await saveCheckin({
      moment: (fd.get("moment") as string) as "before" | "after" | "daily",
      ...(typeof bookingId === "string" && bookingId ? { bookingId } : {}),
      energy: num("energy")!,
      ...(num("sleep") ? { sleep: num("sleep") } : {}),
      calm: num("calm")!,
      mood: num("mood")!,
      ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
    });
    redirect(`${here}?checkin=${res.ok ? "saved" : "error"}` as never);
  }
  return (
    <AccountHome
      locale={locale}
      home={home}
      tr={translator(locale)}
      wellbeing={journey ? { journey, action: saveWellbeing, saved: checkin === "saved" } : null}
    />
  );
}

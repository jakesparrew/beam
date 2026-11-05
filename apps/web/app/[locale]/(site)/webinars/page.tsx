import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { URL_SEGMENT, localeFromSegment } from "@beam/core/i18n";
import { EmptyState } from "@beam/ui";
import { spokenLanguageName, titleIn, webinarDate } from "@beam/email/templates/webinar";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { listPublicWebinarRows } from "@/modules/webinar/queries";
import { WebinarCard } from "@/modules/webinar/ui/webinar-card";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (!locale) return {};
  const tr = translator(locale);
  return { title: tr("webinar.public.list.title"), description: tr("webinar.public.list.intro") };
}

/**
 * `/[locale]/webinars` (webinar spec 5.3, behind `ff_webinar_portal`): upcoming and live live and
 * simulive webinars, then the on-demand ones, each available in the URL locale; dates in Brussels
 * time. Empty state "No webinars planned right now."
 */
export default async function WebinarsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeFromSegment((await params).locale);
  if (!locale) notFound();
  if (!(await flag("ff_webinar_portal", { kind: "public" }))) notFound();
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const now = new Date();
  const rows = await listPublicWebinarRows(await getAppDb(), { locale, from: now, limit: 50 });
  const upcoming = rows.filter((w) => w.mode !== "on_demand");
  const onDemand = rows.filter((w) => w.mode === "on_demand");
  const card = (w: (typeof rows)[number]) => (
    <li key={w.id}>
      <WebinarCard
        title={titleIn(w.title as Record<string, string>, locale)}
        href={`/${seg}/webinars/${w.slug}`}
        when={w.startsAt ? tr("webinar.public.landing.date", { date: webinarDate(w.startsAt, locale) }) : tr("webinar.public.card.on_demand")}
        language={tr("webinar.public.card.language", { language: spokenLanguageName(w.spokenLocale, locale) })}
        badge={w.status === "live" ? tr("webinar.public.card.live_now") : null}
        action={tr("webinar.public.list.open")}
      />
    </li>
  );
  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">{tr("webinar.public.list.title")}</h1>
        <p className="text-muted-foreground">{tr("webinar.public.list.intro")}</p>
      </header>
      {rows.length === 0 ? (
        <EmptyState title={tr("webinar.public.list.empty")} />
      ) : (
        <>
          {upcoming.length ? (
            <section aria-labelledby="webinars-upcoming" className="space-y-3">
              <h2 id="webinars-upcoming" className="text-xl font-semibold">
                {tr("webinar.public.list.upcoming")}
              </h2>
              <ul className="grid gap-4 sm:grid-cols-2">{upcoming.map(card)}</ul>
            </section>
          ) : null}
          {onDemand.length ? (
            <section aria-labelledby="webinars-on-demand" className="space-y-3">
              <h2 id="webinars-on-demand" className="text-xl font-semibold">
                {tr("webinar.public.list.on_demand")}
              </h2>
              <ul className="grid gap-4 sm:grid-cols-2">{onDemand.map(card)}</ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

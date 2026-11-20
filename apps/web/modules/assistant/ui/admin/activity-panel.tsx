/**
 * "Visits and interactions" on the staff person page: visits per week or month (day, night,
 * event, not attended), interactions per period (bookings made, emails, purchases, chat and
 * messages, webinars and forms) and when the person comes (weekday × part of the day).
 */
import type { Locale } from "@beam/core/i18n";
import type { ActivityData } from "../../api";
import { StackedBars, WhenGrid } from "./activity-charts";
import { SURFACE } from "./parts";

type Tr = (key: string, params?: Record<string, string | number>) => string;

export function ActivityPanel({ data, tr, locale }: { data: ActivityData; tr: Tr; locale: Locale }) {
  const t = (k: string, p?: Record<string, string | number>) => tr(`assistant.admin.activity.${k}`, p);
  const fmt = new Intl.DateTimeFormat(locale, data.unit === "week" ? { day: "numeric", month: "short", timeZone: "UTC" } : { month: "short", year: "2-digit", timeZone: "UTC" });
  const labels = data.buckets.map((d) => fmt.format(new Date(`${d}T00:00:00Z`)));
  const common = { labels, tableLabel: t("table"), totalLabel: t("total") };
  return (
    <section className={`${SURFACE} grid gap-6 p-5 sm:p-6`} aria-labelledby="activity-h" data-testid="panel-activity">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="activity-h" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t(data.unit === "week" ? "perWeek" : "perMonth")}</p>
      </div>
      <div className="grid gap-8 xl:grid-cols-2">
        <StackedBars
          {...common}
          title={t("visits")}
          emptyText={t("noVisits")}
          series={[
            { key: "day", label: t("series.day"), values: data.visits.day },
            { key: "night", label: t("series.night"), values: data.visits.night },
            // Fixed palette order: gold, blue, terracotta, green. "Did not come" takes terracotta,
            // never the green that reads as "good".
            { key: "missed", label: t("series.missed"), values: data.visits.missed },
            { key: "event", label: t("series.event"), values: data.visits.event },
          ]}
        />
        <StackedBars
          {...common}
          title={t("interactions")}
          emptyText={t("noInteractions")}
          series={[
            { key: "bookings", label: t("series.bookings"), values: data.interactions.bookings },
            { key: "emails", label: t("series.emails"), values: data.interactions.emails },
            { key: "purchases", label: t("series.purchases"), values: data.interactions.purchases },
            { key: "chat", label: t("series.chat"), values: data.interactions.chat },
            { key: "events", label: t("series.events"), values: data.interactions.events },
          ]}
        />
      </div>
      <div className="max-w-xl">
        <WhenGrid
          title={t("when")}
          heat={data.heat}
          weekdays={[1, 2, 3, 4, 5, 6, 7].map((d) => t(`weekday.${d}`))}
          dayparts={["morning", "afternoon", "evening"].map((p) => t(`daypart.${p}`))}
          emptyText={t("noVisits")}
          visitsLabel={t("visitsUnit")}
        />
      </div>
    </section>
  );
}

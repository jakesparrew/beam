import { appUrl, requireStaff } from "@/lib/auth";
import { adminLocale, translator } from "@/lib/i18n";
import { CopyButton } from "@/modules/platform/ui/copy-button";
import { PageHeader, Surface } from "@/modules/platform/ui/admin-kit";

const K = "site.admin.booking_links";

/** One channel: its UTM source and medium (campaign is always `book_button`). */
const CHANNELS = [
  { key: "google", source: "google", medium: "business_profile" },
  { key: "instagram", source: "instagram", medium: "social" },
  { key: "facebook", source: "facebook", medium: "social" },
  { key: "newsletter", source: "newsletter", medium: "email" },
] as const;

/**
 * `/admin/site/booking-links` (`site.edit`): ready-made "Book" links for Google Business Profile,
 * Instagram, Facebook and emails, each with its own `utm_*` tracking so bookings are attributed
 * to the channel (the booking flow stores the UTM on the order and on a new person's acquisition),
 * with the steps to set the button up on each platform.
 */
export default async function BookingLinksPage() {
  await requireStaff({ permission: "site.edit" });
  const tr = translator(await adminLocale());
  const link = (source: string, medium: string) => appUrl(`/nl/book?utm_source=${source}&utm_medium=${medium}&utm_campaign=book_button`);
  return (
    <div className="grid max-w-4xl gap-5">
      <PageHeader title={tr(`${K}.title`)} description={tr(`${K}.intro`)} />
      <div className="grid gap-3">
        {CHANNELS.map((c) => {
          const url = link(c.source, c.medium);
          return (
            <Surface key={c.key} className="grid gap-3" data-channel={c.key}>
              <h2 className="text-[0.9375rem] font-semibold">{tr(`${K}.${c.key}_name`)}</h2>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-[#faf9f6] px-3 py-2 text-[0.75rem]" title={url}>
                  {url}
                </code>
                <CopyButton value={url} label={tr(`${K}.copy`)} copiedLabel={tr(`${K}.copied`)} />
              </div>
              <p className="text-[0.8125rem] text-muted-foreground">
                <span className="font-medium text-foreground">{tr(`${K}.how`)}: </span>
                {tr(`${K}.${c.key}_steps`)}
              </p>
            </Surface>
          );
        })}
      </div>
      <p className="text-[0.75rem] text-muted-foreground">{tr(`${K}.note`)}</p>
    </div>
  );
}

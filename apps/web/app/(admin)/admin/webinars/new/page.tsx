import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listStaffOptions, webinarFormLabels } from "@/modules/webinar/queries";
import { WebinarForm } from "@/modules/webinar/ui/admin/webinar-form";
import { PageHeader, stepFormLabels } from "@/modules/platform/ui/admin-kit";

export const dynamic = "force-dynamic";

/**
 * `/admin/webinars/new` (`webinars.host`, webinar spec 5.1): mode picker, slug, title and
 * description per language, languages, spoken language, start, planned duration and owner;
 * "Save draft" creates the draft and opens its page. One step per screen (`StepForm`), then a review.
 */
export default async function NewWebinarPage() {
  const actor = await requireStaff({ permission: "webinars.host" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const owners = await listStaffOptions(await getAppDb());
  return (
    <div className="grid gap-6">
      <Link href="/admin/webinars" className="w-fit text-[0.8125rem] text-muted-foreground hover:text-foreground">
        ← {tr("webinar.admin.detail.back")}
      </Link>
      <PageHeader title={tr("webinar.admin.form.new_title")} />
      <WebinarForm
        owners={owners}
        labels={webinarFormLabels(tr)}
        steps={stepFormLabels(tr)}
        initial={{
          mode: "live",
          slug: "",
          title: {},
          description: {},
          locales: ["nl-BE", "fr-BE", "en"],
          spokenLocale: "nl-BE",
          startsAt: "",
          plannedDurationMinutes: 60,
          ownerUserId: actor.userId,
          seriesKey: "",
          isReplayEnabled: true,
          isReplayGated: true,
          replayUntilAt: "",
          replayViewLimit: "",
          onDemandAccessDays: "",
          attendedMinutes: 5,
          conversionWindowDays: 30,
          isChatEnabled: true,
          isQuestionsEnabled: true,
          hostMeetUrl: "",
        }}
      />
    </div>
  );
}

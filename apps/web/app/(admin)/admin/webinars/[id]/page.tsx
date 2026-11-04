import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { Badge, buttonVariants } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { localMinuteKey, wallClock } from "@beam/core/platform";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { adminErrorLabels, fieldNames, getWebinar, listStaffOptions, localeNames, webinarFormLabels } from "@/modules/webinar/queries";
import { publishProblems, textIn } from "@/modules/webinar/server/lifecycle";
import { BroadcastPanel, LifecycleActions } from "@/modules/webinar/ui/admin/broadcast-panel";
import { PresenterList } from "@/modules/webinar/ui/admin/presenter-list";
import { WebinarForm } from "@/modules/webinar/ui/admin/webinar-form";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const brusselsLocal = (d: Date | null) => (d ? localMinuteKey(wallClock(d)) : "");

/**
 * `/admin/webinars/[id]` (`webinars.host`, webinar spec 5.1): the details form with completeness,
 * the broadcast panel (YouTube id and lifecycle, the publishing state, `broadcast_error` in red,
 * the Meet link, "Use different YouTube video"), replay and threshold settings, presenters and the
 * series; Publish, Cancel, Archive, Duplicate to dates and Force live / ended.
 */
export default async function WebinarPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "webinars.host" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const detail = await getWebinar(db, id);
  if (!detail) notFound();
  const { webinar: w } = detail;
  const [staff, problems] = await Promise.all([
    listStaffOptions(db),
    w.status === "draft" ? publishProblems(db, w, new Date()) : Promise.resolve<Record<string, string>>({}),
  ]);

  const errors = adminErrorLabels(tr);
  const names = fieldNames(tr);
  const locNames = localeNames(tr);
  const missingFor = tr("webinar.admin.detail.missing_for", { field: "{field}", locales: "{locales}" });
  const publishing = w.status === "draft" && !!w.publishRequestedAt;
  const editable = w.status !== "cancelled" && w.status !== "archived";
  const errorText =
    w.broadcastError === "never_live"
      ? tr("webinar.admin.broadcast.never_live")
      : w.broadcastError === "video_not_found"
        ? tr("webinar.admin.broadcast.video_not_found")
        : w.broadcastError
          ? tr("webinar.admin.broadcast.error", { error: w.broadcastError })
          : null;
  const problemLines = Object.entries(problems).map(([field, value]) => {
    const item = /^(poll|cta):(.+)$/.exec(field);
    const name = item ? names[item[1]!]!.replace("{key}", item[2]!) : (names[field] ?? field);
    const isLocales = value.split(",").every((l) => l in locNames);
    return isLocales ? missingFor.replace("{field}", name).replace("{locales}", value.split(",").map((l) => locNames[l as keyof typeof locNames]).join(", ")) : `${name}: ${errors[value] ?? value}`;
  });

  return (
    <div className="grid gap-6">
      <Link href="/admin/webinars" className="text-sm underline">
        {tr("webinar.admin.detail.back")}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{textIn(w.title, locale) || w.slug}</h1>
        <Badge variant="outline">{tr(`webinar.enum.mode.${w.mode}`)}</Badge>
        <Badge variant={w.status === "cancelled" ? "destructive" : "secondary"}>{tr(`webinar.enum.status.${w.status}`)}</Badge>
        <span className="text-sm text-muted-foreground">{tr("webinar.admin.detail.registrations", { count: detail.registrations })}</span>
        <Link href={`/admin/webinars/${w.id}/interactive` as Route} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {tr("webinar.admin.detail.interactive")}
        </Link>
      </div>
      {w.status === "cancelled" && w.cancelledReason ? <p className="text-sm text-destructive">{tr("webinar.admin.detail.cancelled_reason", { reason: w.cancelledReason })}</p> : null}

      {w.status === "draft" ? (
        <section aria-labelledby="completeness-title" className="grid gap-2 rounded-md border p-4">
          <h2 id="completeness-title" className="text-lg font-semibold">
            {tr("webinar.admin.detail.completeness")}
          </h2>
          {problemLines.length ? (
            <ul className="list-disc pl-5 text-sm">
              {problemLines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">{tr("webinar.admin.detail.complete")}</p>
          )}
        </section>
      ) : null}

      <LifecycleActions
        webinarId={w.id}
        version={w.version}
        mode={w.mode}
        status={w.status}
        canPublish={w.status === "draft" && !publishing}
        canCancel={w.status === "draft" || w.status === "published"}
        canArchive={w.status === "ended" || w.status === "cancelled" || (w.status === "published" && w.mode === "on_demand")}
        canDuplicate={w.mode !== "on_demand"}
        labels={{
          publish: tr("webinar.admin.detail.publish"),
          publishing: tr("webinar.admin.detail.publishing"),
          published: tr("webinar.admin.detail.published"),
          publishingStarted: tr("webinar.admin.detail.publishing_started"),
          publishFailed: tr("webinar.admin.detail.publish_failed"),
          cancel: tr("webinar.admin.detail.cancel"),
          cancelReason: tr("webinar.admin.detail.cancel_reason"),
          cancelNotify: tr("webinar.admin.detail.cancel_notify"),
          cancelConfirm: tr("webinar.admin.detail.cancel_confirm"),
          cancelled: tr("webinar.admin.detail.cancelled"),
          archive: tr("webinar.admin.detail.archive"),
          archived: tr("webinar.admin.detail.archived"),
          duplicate: tr("webinar.admin.detail.duplicate"),
          duplicateHint: tr("webinar.admin.detail.duplicate_hint"),
          duplicateDate: tr("webinar.admin.detail.duplicate_date"),
          duplicateAdd: tr("webinar.admin.detail.duplicate_add"),
          duplicateRemove: tr("webinar.admin.detail.duplicate_remove"),
          duplicateSubmit: tr("webinar.admin.detail.duplicate_submit"),
          duplicated: tr("webinar.admin.detail.duplicated", { count: 2 }).replace("2", "{count}"),
          forceLive: tr("webinar.admin.detail.force_live"),
          forceEnded: tr("webinar.admin.detail.force_ended"),
          forced: tr("webinar.admin.detail.forced"),
          missingFor,
          fieldNames: names,
          localeNames: locNames,
          errors,
        }}
      />

      <BroadcastPanel
        webinarId={w.id}
        mode={w.mode}
        status={w.status}
        youtubeVideoId={w.youtubeVideoId}
        youtubeLifecycle={w.youtubeLifecycle}
        recordingVideoId={w.recordingVideoId}
        durationLabel={w.durationSec ? tr("webinar.admin.broadcast.duration", { minutes: Math.round(w.durationSec / 60) }) : null}
        hostMeetUrl={w.hostMeetUrl}
        publishing={publishing}
        errorText={errorText}
        labels={{
          title: tr("webinar.admin.broadcast.title"),
          videoId: tr("webinar.admin.broadcast.video_id"),
          lifecycle: tr("webinar.admin.broadcast.lifecycle"),
          lifecycleUnknown: tr("webinar.admin.broadcast.lifecycle_unknown"),
          creating: tr("webinar.admin.broadcast.creating"),
          none: tr("webinar.admin.broadcast.none"),
          studio: tr("webinar.admin.broadcast.studio"),
          meet: tr("webinar.admin.broadcast.meet"),
          meetNone: tr("webinar.admin.broadcast.meet_none"),
          recording: tr("webinar.admin.broadcast.recording"),
          recordingNone: tr("webinar.admin.broadcast.recording_none"),
          useOther: tr("webinar.admin.broadcast.use_other"),
          field: tr("webinar.admin.broadcast.field"),
          fieldBroadcast: tr("webinar.admin.broadcast.field_broadcast"),
          fieldRecording: tr("webinar.admin.broadcast.field_recording"),
          videoIdLabel: tr("webinar.admin.broadcast.video_id_label"),
          set: tr("webinar.admin.broadcast.set"),
          setDone: tr("webinar.admin.broadcast.set_done"),
          errors,
        }}
      />

      <section aria-labelledby="details-title" className="grid gap-3">
        <h2 id="details-title" className="text-lg font-semibold">
          {tr("webinar.admin.detail.details")}
        </h2>
        {editable ? (
          <WebinarForm
            owners={staff}
            labels={webinarFormLabels(tr)}
            initial={{
              webinarId: w.id,
              version: w.version,
              status: w.status,
              mode: w.mode,
              slug: w.slug,
              title: w.title,
              description: w.description,
              locales: w.locales,
              spokenLocale: w.spokenLocale,
              startsAt: brusselsLocal(w.startsAt),
              plannedDurationMinutes: w.plannedDurationMinutes,
              ownerUserId: w.ownerUserId,
              seriesKey: w.seriesKey ?? "",
              isReplayEnabled: w.isReplayEnabled,
              isReplayGated: w.isReplayGated,
              replayUntilAt: brusselsLocal(w.replayUntilAt),
              replayViewLimit: w.replayViewLimit === null ? "" : String(w.replayViewLimit),
              onDemandAccessDays: w.onDemandAccessDays === null ? "" : String(w.onDemandAccessDays),
              attendedMinutes: Math.round(w.attendedMinSec / 60),
              conversionWindowDays: w.conversionWindowDays,
              isChatEnabled: w.isChatEnabled,
              isQuestionsEnabled: w.isQuestionsEnabled,
              hostMeetUrl: w.hostMeetUrl ?? "",
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{w.startsAt ? formatDateTime(w.startsAt, locale, "full") : tr("webinar.admin.list.not_scheduled")}</p>
        )}
      </section>

      <PresenterList
        webinarId={w.id}
        editable={editable}
        staff={staff}
        presenters={detail.presenters.map((p) => ({ id: p.id, displayName: p.displayName, role: p.role, email: p.email, userId: p.userId }))}
        labels={{
          title: tr("webinar.admin.presenters.title"),
          empty: tr("webinar.admin.presenters.empty"),
          kind: tr("webinar.admin.presenters.kind"),
          kindUser: tr("webinar.admin.presenters.kind_user"),
          kindEmail: tr("webinar.admin.presenters.kind_email"),
          user: tr("webinar.admin.presenters.user"),
          email: tr("webinar.admin.presenters.email"),
          displayName: tr("webinar.admin.presenters.display_name"),
          role: tr("webinar.admin.presenters.role"),
          roles: { host: tr("webinar.enum.role.host"), presenter: tr("webinar.enum.role.presenter"), moderator: tr("webinar.enum.role.moderator") },
          add: tr("webinar.admin.presenters.add"),
          remove: tr("webinar.admin.presenters.remove"),
          saved: tr("webinar.admin.presenters.saved"),
          errors,
        }}
      />

      <section aria-labelledby="series-title" className="grid gap-2 rounded-md border p-4">
        <h2 id="series-title" className="text-lg font-semibold">
          {tr("webinar.admin.detail.series")}
        </h2>
        {detail.series.length ? (
          <ul className="grid gap-1 text-sm">
            {detail.series.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/webinars/${s.id}` as Route} className="underline">
                  {s.startsAt ? formatDateTime(s.startsAt, locale) : s.slug}
                </Link>
                <Badge variant="outline">{tr(`webinar.enum.status.${s.status}`)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{tr("webinar.admin.detail.series_empty")}</p>
        )}
      </section>
    </div>
  );
}

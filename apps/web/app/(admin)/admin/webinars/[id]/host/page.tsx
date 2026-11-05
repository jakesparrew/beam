import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { adminErrorLabels, getHostConsoleState, type MessageRow } from "@/modules/webinar/queries";
import { textIn } from "@/modules/webinar/server/lifecycle";
import { HostConsole } from "@/modules/webinar/ui/host/host-console";
import type { HostMessage } from "@/modules/webinar/ui/host/chat-moderation";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The host console's own error messages (`webinar.admin.errors.*`, server/interactions.ts). */
const HOST_ERROR_KEYS = [
  "not_live",
  "inactive",
  "not_launched",
  "not_shown",
  "not_registered",
  "cancelled",
  "not_blocked",
  "not_a_question",
  "message_not_found",
  "registration_not_found",
] as const;

/**
 * `/admin/webinars/[id]/host` (`webinars.host`, webinar spec 5.1, rules 10, 13, 34, 37, 42): the
 * host console. Hosts present in Google Meet (the host link) and stream to the YouTube broadcast
 * BEAM created; here they launch polls and CTAs, read the chat and the questions, moderate, and
 * force the live state when YouTube's status is unavailable. Message times are Brussels time.
 */
export default async function WebinarHostPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "webinars.host" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const state = await getHostConsoleState(await getAppDb(), id);
  if (!state) notFound();
  const { webinar: w } = state;
  const g = (k: string, p?: Record<string, string>) => tr(`webinar.admin.host.${k}`, p);
  const time = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const message = (m: MessageRow): HostMessage => ({
    id: m.id,
    registrationId: m.registrationId,
    name: m.name,
    text: m.text,
    time: time.format(m.at),
    mode: m.mode,
    hidden: m.hidden,
    answered: m.answered,
    muted: m.muted,
    blocked: m.blocked,
  });
  const modes = { live: tr("webinar.enum.watch_mode.live"), replay: tr("webinar.enum.watch_mode.replay"), on_demand: tr("webinar.enum.watch_mode.on_demand") };
  const statuses = Object.fromEntries(["draft", "published", "live", "ended", "cancelled", "archived"].map((s) => [s, tr(`webinar.enum.status.${s}`)]));
  const errors = { ...adminErrorLabels(tr), ...Object.fromEntries(HOST_ERROR_KEYS.map((k) => [k, tr(`webinar.admin.errors.${k}`)])) };

  return (
    <div className="grid gap-6">
      <Link href={`/admin/webinars/${w.id}` as Route} className="text-sm underline underline-offset-2">
        {g("back")}: {textIn(w.title, locale) || w.slug}
      </Link>
      <h1 className="text-2xl font-semibold">{g("title")}</h1>
      <HostConsole
        webinarId={w.id}
        mode={w.mode}
        status={w.status}
        hostMeetUrl={w.hostMeetUrl}
        studioUrl={state.studioUrl}
        youtubeLifecycle={w.youtubeLifecycle}
        broadcastError={w.broadcastError}
        liveStarted={w.liveStartedAt !== null}
        viewerCount={state.viewerCount}
        elapsedSec={state.elapsedSec}
        preflightAlert={state.preflightAlert}
        polls={state.polls.map((p) => ({
          id: p.id,
          key: p.key,
          question: textIn(p.question, locale) || p.key,
          options: p.options.map((o) => ({ key: o.key, label: textIn(o.label, locale) || o.key, counts: p.results[o.key] ?? { live: 0, replay: 0, on_demand: 0 } })),
          isActive: p.isActive,
          open: p.open,
          respondents: p.respondents,
        }))}
        ctas={state.ctas.map((c) => ({
          id: c.id,
          key: c.key,
          label: textIn(c.label, locale) || c.key,
          url: c.url,
          isActive: c.isActive,
          open: c.open,
          shown: c.shown,
          clicked: c.clicked,
        }))}
        chat={state.chat.map(message)}
        questions={state.questions.map(message)}
        labels={{
          meetLink: g("meet_link"),
          meetMissing: g("meet_missing"),
          studioLink: g("studio_link"),
          status: g("status"),
          lifecycle: g("lifecycle"),
          lifecycleUnknown: g("lifecycle_unknown"),
          viewers: g("viewers"),
          elapsed: g("elapsed"),
          notStarted: g("not_started"),
          waiting: g("waiting"),
          preflight: g("preflight"),
          broadcastError: g("broadcast_error", { error: "{error}" }),
          forceLive: g("force_live"),
          forceEnded: g("force_ended"),
          forceHint: g("force_hint"),
          refreshing: g("refreshing"),
          saved: g("saved"),
          statuses,
          errors,
          items: {
            polls: g("polls"),
            ctas: g("ctas"),
            noItems: g("no_items"),
            interactiveLink: g("interactive_link"),
            interactiveHref: `/admin/webinars/${w.id}/interactive`,
            launch: g("launch"),
            close: g("close"),
            show: g("show"),
            hide: g("hide"),
            onScreen: g("on_screen"),
            inactive: g("inactive"),
            liveOnly: g("live_only"),
            respondents: g("respondents", { count: "{count}" }),
            replayAnswers: g("replay_answers", { count: "{count}" }),
            ctaCounts: g("cta_counts", { shown: "{shown}", clicked: "{clicked}" }),
          },
          moderation: {
            chat: g("chat"),
            questions: g("questions"),
            noChat: g("no_chat"),
            noQuestions: g("no_questions"),
            hideMessage: g("hide_message"),
            unhideMessage: g("unhide_message"),
            markAnswered: g("mark_answered"),
            answered: g("answered"),
            hidden: g("hidden"),
            mute: g("mute"),
            unmute: g("unmute"),
            block: g("block"),
            unblock: g("unblock"),
            muted: g("muted"),
            blocked: g("blocked"),
            confirmBlock: g("confirm_block"),
            anonymous: g("anonymous"),
            modes,
          },
        }}
      />
    </div>
  );
}

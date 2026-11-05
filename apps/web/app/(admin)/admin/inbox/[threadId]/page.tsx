import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime, formatMoney, LOCALES, type Locale } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { actorHasPermission, getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { adminLocale, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { searchPersons } from "@/modules/crm/api";
import { getPersonSidebar, getThread, listInboxAssignees, listReplyTemplates } from "@/modules/crm/inbox/queries";
import { PersonSidebar, type SidebarPerson } from "@/modules/crm/ui/inbox/person-sidebar";
import { ReplyBox } from "@/modules/crm/ui/inbox/reply-box";
import { ThreadView, type MessageView } from "@/modules/crm/ui/inbox/thread-view";

const LOCALE_KEY: Record<Locale, string> = { "nl-BE": "nl_BE", "fr-BE": "fr_BE", en: "en" };
const DELIVERY_REASONS = new Set(["window_closed", "permission", "meta_disabled"]);

/** `/admin/inbox/[threadId]` (`persons.read`; writes `persons.write`), crm spec 5.1. */
export default async function InboxThreadPage({ params, searchParams }: { params: Promise<{ threadId: string }>; searchParams: Promise<{ q?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  if (!(await flag("ff_crm_inbox", actor))) notFound();
  const { threadId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const p = (k: string, values?: Record<string, string | number>) => tr(`crm.inbox.${k}`, values);
  const db = await getAppDb();
  const now = new Date();

  const thread = await getThread(db, threadId, now);
  if (!thread) notFound();
  const meta = thread.channel === "instagram" || thread.channel === "messenger";
  const showMeta = await flag("ff_crm_inbox_meta", actor);
  if (meta && !showMeta) notFound();
  const canWrite = actorHasPermission(actor, "persons.write");

  const [assignees, templates, sidebar, inboxSettings] = await Promise.all([
    listInboxAssignees(db),
    listReplyTemplates(db),
    thread.personId ? getPersonSidebar(db, thread.personId) : Promise.resolve(null),
    getSetting(db, "inbox"),
  ]);
  const query = (sp.q ?? "").trim().slice(0, 100);
  const results = !thread.personId && canWrite && query.length >= 2 ? await searchPersons(db, { q: query, limit: 8 }) : [];
  const replyLocale: Locale = sidebar?.locale ?? "nl-BE";

  const blockedReason =
    thread.replyBlockedReason === "meta_window_closed"
      ? p("reply.window_closed")
      : thread.replyBlockedReason === "no_recipient"
        ? p("reply.no_recipient")
        : meta && !inboxSettings.meta_enabled
          ? p("reply.meta_disabled")
          : null;
  const hint = meta && !blockedReason && thread.metaWindowClosesAt ? p("reply.window_closes", { time: formatDateTime(thread.metaWindowClosesAt, locale, "short") }) : null;

  const messages: MessageView[] = thread.messages.map((m) => {
    const metaLines: string[] = [];
    if (m.sentByName) metaLines.push(p("thread.sent_by", { name: m.sentByName }));
    if (m.attachmentCount > 0) metaLines.push(p("thread.attachments", { count: m.attachmentCount }));
    if (m.emailStatus) metaLines.push(p("thread.email_status", { status: m.emailStatus }));
    if (m.delivered === false && !m.deliveryError) metaLines.push(p("thread.delivering"));
    const reason = m.deliveryError ? p(`delivery.${DELIVERY_REASONS.has(m.deliveryError) ? m.deliveryError : "other"}`) : null;
    return {
      id: m.id,
      direction: m.direction,
      directionLabel: tr(`crm.enums.inbox_message_direction.${m.direction}`),
      body: m.body,
      occurredAt: formatDateTime(m.occurredAt, locale, "short"),
      meta: metaLines,
      problem: reason ? p("thread.not_delivered", { reason }) : null,
    };
  });

  const facts = [
    { label: p("thread.received"), value: formatDateTime(thread.createdAt, locale, "short") },
    { label: p("thread.first_response"), value: thread.firstResponseAt ? formatDateTime(thread.firstResponseAt, locale, "short") : "—" },
    ...(thread.escalatedAt ? [{ label: p("thread.escalated_at"), value: formatDateTime(thread.escalatedAt, locale, "short") }] : []),
    { label: p("thread.from"), value: thread.fromAddress ?? "—" },
  ];

  const person: SidebarPerson | null = sidebar
    ? {
        id: sidebar.id,
        name: sidebar.name,
        email: sidebar.email,
        facts: [
          { label: p("person.status"), value: tr(`crm.enums.person_status.${sidebar.status}`) },
          {
            label: p("person.credits"),
            value: sidebar.credits.length
              ? sidebar.credits.map((c) => `${tr(`credits.enum.kind.${c.kind}`)}: ${c.kind === "euro" ? formatMoney(c.remainingUnits, locale) : c.remainingUnits}`).join(", ")
              : p("person.no_credits"),
          },
          ...(sidebar.membership ? [{ label: p("person.membership"), value: sidebar.membership }] : []),
          { label: p("person.next_booking"), value: sidebar.nextBookingAt ? formatDateTime(sidebar.nextBookingAt, locale, "short") : p("person.no_booking") },
        ],
      }
    : null;

  return (
    <div className="grid gap-4">
      <Link href="/admin/inbox" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        {p("back")}
      </Link>
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-4">
          <ThreadView
            header={{
              id: thread.id,
              subject: thread.subject ?? p("no_subject"),
              sender: thread.fromName ?? sidebar?.name ?? thread.fromAddress ?? "—",
              channelLabel: tr(`crm.enums.inbox_channel.${thread.channel}`),
              status: thread.status,
              statusLabel: tr(`crm.enums.inbox_thread_status.${thread.status}`),
              assigneeUserId: thread.assigneeUserId,
              isSensitive: thread.isSensitive,
              facts,
              escalated: !!thread.escalatedAt,
            }}
            messages={messages}
            assignees={assignees.map((a) => ({ value: a.userId, label: a.name }))}
            canWrite={canWrite}
            labels={{
              assignee: p("thread.assignee"),
              nobody: p("nobody"),
              resolve: p("thread.resolve"),
              reopen: p("thread.reopen"),
              sensitive: p("thread.sensitive"),
              sensitiveHint: p("thread.sensitive_hint"),
              escalated: p("escalated"),
              error: p("thread.error"),
              conflict: p("thread.conflict"),
              saving: tr("crm.common.saving"),
            }}
          />
          {canWrite ? (
            <ReplyBox
              threadId={thread.id}
              templates={templates.map((t) => ({ key: t.key, name: t.name[locale] ?? t.key, body: t.body[replyLocale] ?? "" }))}
              blockedReason={blockedReason}
              hint={hint}
              labels={{
                reply: p("reply.reply"),
                note: p("reply.note"),
                placeholderReply: p("reply.placeholder_reply"),
                placeholderNote: p("reply.placeholder_note"),
                send: p("reply.send"),
                addNote: p("reply.add_note"),
                sending: p("reply.sending"),
                template: p("reply.template"),
                noTemplate: p("reply.no_template"),
                error: p("reply.error"),
                sent: p("reply.sent"),
                noteSaved: p("reply.note_saved"),
              }}
            />
          ) : null}
        </div>
        <PersonSidebar
          threadId={thread.id}
          person={person}
          results={results.map((r) => ({ id: r.personId, label: [r.name, r.email, r.customerNumber].filter(Boolean).join(" · ") }))}
          query={query}
          canWrite={canWrite}
          labels={{
            title: p("person.title"),
            open: p("person.open"),
            unlinked: p("person.unlinked"),
            search: p("person.search"),
            searchPlaceholder: p("person.search_placeholder"),
            searchButton: p("person.search_button"),
            link: p("person.link"),
            noResults: p("person.no_results"),
            create: p("person.create"),
            createLocale: p("person.create_locale"),
            error: p("person.error"),
            locales: LOCALES.map((l) => ({ value: l, label: tr(`crm.enums.locale.${LOCALE_KEY[l]}`) })),
          }}
        />
      </div>
    </div>
  );
}

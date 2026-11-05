import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, buttonVariants } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { INBOX_CHANNELS, INBOX_THREAD_STATUSES, type InboxChannel, type InboxThreadStatus } from "@beam/db/schema";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { adminLocale, translator } from "@/lib/i18n";
import { listInboxAssignees, listThreads } from "@/modules/crm/inbox/queries";
import { ThreadList, type ThreadListItem } from "@/modules/crm/ui/inbox/thread-list";

type Search = { status?: string; assignee?: string; channel?: string; escalated?: string };

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** `/admin/inbox` (`persons.read`, flag `ff_crm_inbox`), crm spec 5.1: the thread list with filters. */
export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  if (!(await flag("ff_crm_inbox", actor))) notFound();
  const showMeta = await flag("ff_crm_inbox_meta", actor);
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const p = (k: string, params?: Record<string, string | number>) => tr(`crm.inbox.${k}`, params);
  const db = await getAppDb();

  const status: InboxThreadStatus | "all" = sp.status === "all" ? "all" : (INBOX_THREAD_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as InboxThreadStatus) : "open";
  const channels = INBOX_CHANNELS.filter((c) => showMeta || (c !== "instagram" && c !== "messenger"));
  const channel = (channels as readonly string[]).includes(sp.channel ?? "") ? (sp.channel as InboxChannel) : "all";
  const assignees = await listInboxAssignees(db);
  const assignee = sp.assignee === "me" || sp.assignee === "unassigned" || assignees.some((a) => a.userId === sp.assignee) ? sp.assignee! : "all";
  const escalatedOnly = sp.escalated === "1";

  const rows = await listThreads(db, { status, channel, assignee, userId: actor.userId, escalatedOnly, hideMeta: !showMeta, limit: 200 });
  const items: ThreadListItem[] = rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    channelLabel: tr(`crm.enums.inbox_channel.${r.channel}`),
    sender: r.sender,
    linked: !!r.personId,
    subject: r.subject ?? p("no_subject"),
    preview: r.lastMessagePreview,
    status: r.status,
    statusLabel: tr(`crm.enums.inbox_thread_status.${r.status}`),
    assignee: r.assigneeName ?? p("nobody"),
    lastMessageAt: formatDateTime(r.lastMessageAt, locale, "short"),
    escalated: r.escalated,
  }));
  const filtered = status !== "open" || channel !== "all" || assignee !== "all" || escalatedOnly;

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{p("title")}</h1>
      </header>
      <form className="flex flex-wrap items-end gap-2" role="search">
        <select name="status" defaultValue={status} aria-label={p("filter_status")} className={selectClass}>
          {INBOX_THREAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {tr(`crm.enums.inbox_thread_status.${s}`)}
            </option>
          ))}
          <option value="all">{p("all_statuses")}</option>
        </select>
        <select name="assignee" defaultValue={assignee} aria-label={p("filter_assignee")} className={selectClass}>
          <option value="all">{p("anyone")}</option>
          <option value="me">{p("me")}</option>
          <option value="unassigned">{p("unassigned")}</option>
          {assignees.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.name}
            </option>
          ))}
        </select>
        <select name="channel" defaultValue={channel} aria-label={p("filter_channel")} className={selectClass}>
          <option value="all">{p("all_channels")}</option>
          {channels.map((c) => (
            <option key={c} value={c}>
              {tr(`crm.enums.inbox_channel.${c}`)}
            </option>
          ))}
        </select>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="escalated" value="1" defaultChecked={escalatedOnly} className="size-4" />
          {p("filter_escalated")}
        </label>
        <Button type="submit" variant="outline">
          {p("filter")}
        </Button>
        {filtered ? (
          <Link href="/admin/inbox" className={buttonVariants({ variant: "ghost" })}>
            {tr("crm.common.clear_filters")}
          </Link>
        ) : null}
      </form>
      <ThreadList items={items} labels={{ list: p("list_label"), escalated: p("escalated"), unlinked: p("unlinked"), empty: filtered ? p("empty_filtered") : p("empty") }} />
    </div>
  );
}

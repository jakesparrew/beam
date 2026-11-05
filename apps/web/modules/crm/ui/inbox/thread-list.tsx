/**
 * The inbox thread list (crm spec 5.1): channel, sender or person, subject, last message,
 * status, assignee and an escalated badge. The page formats every value on the server; this
 * component only lays them out (no client state).
 */
import Link from "next/link";
import { Badge, EmptyState } from "@beam/ui";

export type ThreadListItem = {
  id: string;
  channel: string;
  channelLabel: string;
  sender: string;
  linked: boolean;
  subject: string;
  preview: string;
  status: string;
  statusLabel: string;
  assignee: string;
  lastMessageAt: string;
  escalated: boolean;
};

export type ThreadListLabels = { list: string; escalated: string; unlinked: string; empty: string };

const CHANNEL_MARK: Record<string, string> = { email: "@", instagram: "IG", messenger: "M", form: "F" };

export function ThreadList({ items, labels, selectedId }: { items: ThreadListItem[]; labels: ThreadListLabels; selectedId?: string }) {
  if (items.length === 0) return <EmptyState title={labels.empty} />;
  return (
    <ul aria-label={labels.list} className="divide-y rounded-md border">
      {items.map((t) => (
        <li key={t.id}>
          <Link
            href={`/admin/inbox/${t.id}`}
            aria-current={t.id === selectedId ? "page" : undefined}
            className="grid grid-cols-[auto_1fr_auto] items-start gap-3 p-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-muted"
          >
            <span title={t.channelLabel} aria-label={t.channelLabel} className="mt-0.5 inline-flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
              {CHANNEL_MARK[t.channel] ?? "?"}
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{t.sender}</span>
                {!t.linked ? <span className="shrink-0 text-xs text-muted-foreground">{labels.unlinked}</span> : null}
              </span>
              <span className="truncate text-sm">{t.subject}</span>
              <span className="truncate text-sm text-muted-foreground">{t.preview}</span>
            </span>
            <span className="grid justify-items-end gap-1 text-right text-xs text-muted-foreground">
              <time>{t.lastMessageAt}</time>
              <span className="flex flex-wrap justify-end gap-1">
                {t.escalated ? <Badge variant="destructive">{labels.escalated}</Badge> : null}
                <Badge variant={t.status === "open" ? "default" : t.status === "pending" ? "warning" : "secondary"}>{t.statusLabel}</Badge>
              </span>
              <span>{t.assignee}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

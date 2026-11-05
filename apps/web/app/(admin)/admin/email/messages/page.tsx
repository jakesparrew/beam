import Link from "next/link";
import { Badge, Button, EmptyState, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { catalogueSection, listMessages, ListMessagesInput } from "@/modules/email/queries";

type Search = { status?: string; kind?: string; q?: string; from?: string; to?: string; page?: string; person?: string };

const STATUSES = ["queued", "blocked_translation", "suppressed", "sent", "delivered", "bounced", "complained", "failed"] as const;
const KINDS = ["transactional", "campaign", "automation", "test"] as const;

const fill = (text: string, params: Record<string, string | number> = {}) => text.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));

/**
 * `/admin/email/messages` (`email.write`), email spec section 5: the message log with time,
 * recipient (masked unless `persons.read`), template, kind, status and campaign; filters by
 * status, kind, period and search (template, campaign, or an address prefix with `persons.read`).
 */
export default async function EmailMessagesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "email.write" });
  const sp = await searchParams;
  const parsed = ListMessagesInput.safeParse({
    status: (STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status : undefined,
    kind: (KINDS as readonly string[]).includes(sp.kind ?? "") ? sp.kind : undefined,
    q: sp.q || undefined,
    personId: sp.person || undefined,
    from: sp.from || undefined,
    // The "to" day is inclusive.
    to: sp.to && !Number.isNaN(Date.parse(sp.to)) ? new Date(Date.parse(sp.to) + 86_400_000) : undefined,
    page: sp.page || 1,
  });
  const args = parsed.success ? parsed.data : ListMessagesInput.parse({});
  const db = await getAppDb();
  const list = await listMessages(db, args, { unmasked: hasPermission(actor, "persons.read") });
  const locale = await adminLocale();
  const labels = catalogueSection(locale, "email.messages");
  const t = (key: string, params?: Record<string, string | number>) => fill(labels[key] ?? key, params);
  const time = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" });
  const filtered = !!(args.status || args.kind || args.q || args.personId || args.from || args.to);
  const query = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: args.status, kind: args.kind, q: args.q, person: args.personId, from: sp.from, to: sp.to })) if (v) p.set(k, String(v));
    p.set("page", String(page));
    return `/admin/email/messages?${p.toString()}`;
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Button variant="ghost" asChild>
          <Link href="/admin/email">{t("back_overview")}</Link>
        </Button>
      </div>
      <form className="flex flex-wrap items-end gap-3" method="get">
        {args.personId ? <input type="hidden" name="person" value={args.personId} /> : null}
        <div className="grid gap-1">
          <Label htmlFor="messages-q">{t("search")}</Label>
          <Input id="messages-q" name="q" defaultValue={args.q ?? ""} placeholder={t("search_hint")} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="messages-status">{t("col_status")}</Label>
          <select id="messages-status" name="status" defaultValue={args.status ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">{t("all")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status_${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="messages-kind">{t("col_kind")}</Label>
          <select id="messages-kind" name="kind" defaultValue={args.kind ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">{t("all")}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind_${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="messages-from">{t("from")}</Label>
          <Input id="messages-from" name="from" type="date" defaultValue={sp.from ?? ""} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="messages-to">{t("to")}</Label>
          <Input id="messages-to" name="to" type="date" defaultValue={sp.to ?? ""} />
        </div>
        <Button type="submit" variant="outline">
          {t("apply")}
        </Button>
      </form>
      {list.items.length ? (
        <Table data-testid="messages-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("col_time")}</TableHead>
              <TableHead>{t("col_recipient")}</TableHead>
              <TableHead>{t("col_template")}</TableHead>
              <TableHead>{t("col_kind")}</TableHead>
              <TableHead>{t("col_status")}</TableHead>
              <TableHead>{t("col_campaign")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((m) => (
              <TableRow key={m.id} data-message-id={m.id}>
                <TableCell>
                  <Link className="underline" href={`/admin/email/messages/${m.id}`}>
                    {time.format(m.sentAt ?? m.createdAt)}
                  </Link>
                </TableCell>
                <TableCell>{m.email ?? "–"}</TableCell>
                <TableCell>{m.templateSlug ?? "–"}</TableCell>
                <TableCell>{t(`kind_${m.kind}`)}</TableCell>
                <TableCell>
                  <Badge variant={m.status === "bounced" || m.status === "complained" || m.status === "failed" ? "destructive" : "secondary"}>{t(`status_${m.status}`)}</Badge>
                  {m.error ? <span className="ml-2 text-xs text-muted-foreground">{m.error}</span> : null}
                </TableCell>
                <TableCell>{m.campaignId ? <Link href={`/admin/campaigns/${m.campaignId}/report`}>{m.campaignName ?? "–"}</Link> : "–"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState title={filtered ? t("empty") : t("empty_none")} />
      )}
      {list.page > 1 || list.hasMore ? (
        <nav className="flex items-center gap-2" aria-label={t("pagination")}>
          {list.page > 1 ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={query(list.page - 1) as never}>{t("previous")}</Link>
            </Button>
          ) : null}
          <span className="text-sm">{t("page", { page: list.page })}</span>
          {list.hasMore ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={query(list.page + 1) as never}>{t("next")}</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

import type { Route } from "next";
import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listMessages, ListMessagesInput } from "@/modules/email/queries";
import { SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { aboveRow, Disclosure, Field, fieldClass, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";
import { EmailHeader } from "../../campaigns/email-header";

type Search = { status?: string; kind?: string; q?: string; from?: string; to?: string; page?: string; person?: string };

const STATUSES = ["queued", "blocked_translation", "suppressed", "sent", "delivered", "bounced", "complained", "failed"] as const;
const KINDS = ["transactional", "campaign", "automation", "test"] as const;

const fill = (text: string, params: Record<string, string | number> = {}) => text.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));

/**
 * `/admin/email/messages` (`email.write`), email spec section 5, the "Verzonden berichten" tab of
 * the newsletters page (owner review, November 2026): the message log with time,
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
  const tr = translator(locale);
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

  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: args.status, kind: args.kind, q: args.q, person: args.personId, from: sp.from, to: sp.to, ...patch })) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/admin/email/messages?${s}` : "/admin/email/messages";
  };
  const more = [args.status, sp.from, sp.to].filter(Boolean).length;
  const tone = (s: string): Tone => (s === "bounced" || s === "complained" || s === "failed" ? "bad" : s === "delivered" || s === "sent" ? "ok" : s === "queued" ? "info" : s === "blocked_translation" ? "warn" : "muted");

  return (
    <div className="grid gap-4">
      <EmailHeader active="messages" canWrite tr={tr} />
      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          {args.personId ? <input type="hidden" name="person" value={args.personId} /> : null}
          {args.kind ? <input type="hidden" name="kind" value={args.kind} /> : null}
          <SearchField label={t("search")} placeholder={t("search_hint")} defaultValue={args.q} />
          <Segmented
            label={t("col_kind")}
            items={[{ key: "all", label: t("all"), href: href({ kind: undefined, page: undefined }), active: !args.kind }, ...KINDS.map((k) => ({ key: k, label: t(`kind_${k}`), href: href({ kind: k, page: undefined }), active: args.kind === k }))]}
          />
          <Disclosure label={t("apply")} count={more} clear={more ? { href: href({ status: undefined, from: undefined, to: undefined, page: undefined }), label: t("clear") } : null}>
            <Field label={t("col_status")}>
              <select id="messages-status" name="status" defaultValue={args.status ?? ""} className={fieldClass}>
                <option value="">{t("all")}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status_${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("from")}>
                <input id="messages-from" name="from" type="date" defaultValue={sp.from ?? ""} className={fieldClass} />
              </Field>
              <Field label={t("to")}>
                <input id="messages-to" name="to" type="date" defaultValue={sp.to ?? ""} className={fieldClass} />
              </Field>
            </div>
          </Disclosure>
        </Toolbar>
      </form>
      {list.items.length ? (
        <Surface flush>
          <div className="overflow-x-auto">
            <table data-testid="messages-table" className="w-full min-w-[52rem] text-[0.8125rem]">
              <caption className="sr-only">{t("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-40")}>{t("col_time")}</th>
                  <th scope="col" className={th}>{t("col_recipient")}</th>
                  <th scope="col" className={cn(th, "w-48")}>{t("col_template")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{t("col_kind")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{t("col_status")}</th>
                  <th scope="col" className={cn(th, "w-48")}>{t("col_campaign")}</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((m) => (
                  <tr key={m.id} data-message-id={m.id} className={rowClass}>
                    <td className={cn(td, "whitespace-nowrap tabular-nums")}>
                      <Link className={cn(rowLink, "font-semibold hover:underline")} href={`/admin/email/messages/${m.id}`}>
                        {time.format(m.sentAt ?? m.createdAt)}
                      </Link>
                    </td>
                    <td className={cn(td, "max-w-0 truncate")}>{m.email ?? "–"}</td>
                    <td className={cn(td, "font-mono text-[0.75rem] text-muted-foreground")}>{m.templateSlug ?? "–"}</td>
                    <td className={td}>{t(`kind_${m.kind}`)}</td>
                    <td className={td}>
                      <span className="grid gap-0.5">
                        <StatusPill tone={tone(m.status)} className="w-fit">
                          {t(`status_${m.status}`)}
                        </StatusPill>
                        {m.error ? <span className="truncate text-[0.6875rem] text-muted-foreground">{m.error}</span> : null}
                      </span>
                    </td>
                    <td className={td}>
                      {m.campaignId ? (
                        <Link className={cn(aboveRow, "hover:underline")} href={`/admin/campaigns/${m.campaignId}/report`}>
                          {m.campaignName ?? "–"}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      ) : (
        <EmptyState title={filtered ? t("empty") : t("empty_none")} />
      )}
      {list.page > 1 || list.hasMore ? (
        <nav className="flex items-center gap-2" aria-label={t("pagination")}>
          {list.page > 1 ? <SecondaryAction href={query(list.page - 1) as Route}>{t("previous")}</SecondaryAction> : null}
          <span className="text-[0.8125rem] text-muted-foreground">{t("page", { page: list.page })}</span>
          {list.hasMore ? <SecondaryAction href={query(list.page + 1) as Route}>{t("next")}</SecondaryAction> : null}
        </nav>
      ) : null}
    </div>
  );
}

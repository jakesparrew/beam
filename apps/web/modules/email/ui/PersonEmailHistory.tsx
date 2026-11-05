/**
 * `PersonEmailHistory({ personId })` (email spec section 5 and rule 63): the "Emails" tab crm
 * renders on `/admin/persons/[id]` (`persons.read`). Every message to the person (campaign,
 * automation, transactional; test sends excluded), newest first, 50 per page, with the campaign
 * or automation name, status, opened and clicked times; reachability per marketing purpose with
 * the reason; Resend for transactional messages (`persons.write`) and a link to the message
 * (`email.write`). Addresses and subjects are shown only with `persons.read`.
 *
 * crm calls it as a function (`PersonEmailHistory({ personId })`); tests pass `db`, `locale`,
 * `page` and the permissions instead of the signed-in session.
 */
import type { ReactElement } from "react";
import Link from "next/link";
import type { DbOrTx } from "@beam/db";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { Locale } from "@beam/core/i18n";
import { getAppDb } from "@/lib/ctx";
import { catalogueSection, listPersonEmailHistory, personReachability } from "../queries";
import { ResendMessageButton } from "./CampaignReport";

export type PersonEmailHistoryProps = {
  personId: string;
  /** Defaults to the app database (tests pass theirs). */
  db?: DbOrTx;
  /** Defaults to the signed-in staff user's admin locale. */
  locale?: Locale;
  page?: number;
  /** Default to the signed-in staff user's permissions. */
  canReadPersons?: boolean;
  canWritePersons?: boolean;
  canOpenMessages?: boolean;
};

const fill = (text: string, params: Record<string, string | number> = {}) => text.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));

async function sessionDefaults(props: PersonEmailHistoryProps): Promise<{ locale: Locale; read: boolean; write: boolean; open: boolean }> {
  const needSession = props.locale === undefined || props.canReadPersons === undefined || props.canWritePersons === undefined || props.canOpenMessages === undefined;
  if (!needSession) return { locale: props.locale!, read: props.canReadPersons!, write: props.canWritePersons!, open: props.canOpenMessages! };
  const { hasPermission, requireStaff } = await import("@/lib/auth");
  const { adminLocale } = await import("@/lib/i18n");
  const actor = await requireStaff();
  return {
    locale: props.locale ?? (await adminLocale()),
    read: props.canReadPersons ?? hasPermission(actor, "persons.read"),
    write: props.canWritePersons ?? hasPermission(actor, "persons.write"),
    open: props.canOpenMessages ?? hasPermission(actor, "email.write"),
  };
}

export async function PersonEmailHistory(props: PersonEmailHistoryProps): Promise<ReactElement> {
  const { locale, read, write, open } = await sessionDefaults(props);
  const db = props.db ?? (await getAppDb());
  const labels = catalogueSection(locale, "email.messages");
  const t = (key: string, params?: Record<string, string | number>) => fill(labels[key] ?? key, params);
  const [history, reach] = await Promise.all([listPersonEmailHistory(db, { personId: props.personId, page: props.page ?? 1 }, { unmasked: read }), personReachability(db, props.personId)]);
  const time = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" });
  const at = (d: Date | null) => (d ? time.format(d) : "–");

  return (
    <div className="grid gap-4" data-testid="person-email-history">
      {reach.length ? (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label={t("history_reachability")} data-testid="person-email-reachability">
          {reach.map((r) => (
            <li key={r.purpose} data-purpose={r.purpose} data-reachable={r.isReachable ? "true" : "false"}>
              <Badge variant={r.isReachable ? "default" : "secondary"}>
                {t(`purpose_${r.purpose}`)}: {r.isReachable ? t("reachable") : t(`blocked_${r.blockedReason ?? "no_consent"}`)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {history.items.length ? (
        <Table data-testid="person-email-rows">
          <TableHeader>
            <TableRow>
              <TableHead>{t("col_time")}</TableHead>
              <TableHead>{t("col_message")}</TableHead>
              <TableHead>{t("col_status")}</TableHead>
              <TableHead>{t("col_opened")}</TableHead>
              <TableHead>{t("col_clicked")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.items.map((m) => (
              <TableRow key={m.id} data-message-id={m.id} data-status={m.status}>
                <TableCell>{at(m.sentAt ?? m.createdAt)}</TableCell>
                <TableCell>
                  <div className="grid">
                    <span>{m.campaignName ?? m.automationName ?? m.templateSlug ?? "–"}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(`kind_${m.kind}`)}
                      {m.subject ? ` · ${m.subject}` : ""}
                      {m.email ? ` · ${m.email}` : ""}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={m.status === "bounced" || m.status === "complained" || m.status === "failed" ? "destructive" : "secondary"}>{t(`status_${m.status}`)}</Badge>
                </TableCell>
                <TableCell>{at(m.openedAt)}</TableCell>
                <TableCell>{at(m.clickedAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {write && m.canResend ? <ResendMessageButton messageId={m.id} labels={labels} size="sm" /> : null}
                    {open ? (
                      <Link className="text-sm underline" href={`/admin/email/messages/${m.id}`}>
                        {t("open")}
                      </Link>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="person-email-empty">
          {t("history_empty")}
        </p>
      )}
      {history.nextPage ? (
        <p className="text-xs text-muted-foreground">
          {t("history_more", { count: history.items.length })}{" "}
          {open ? (
            <Link className="underline" href={`/admin/email/messages?person=${props.personId}` as never}>
              {t("history_all")}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

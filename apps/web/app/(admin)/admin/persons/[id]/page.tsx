import type { ReactNode } from "react";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { CONSENT_PURPOSES, MARKETING_PURPOSES, normalisePhone, onboardingProgress, TIMELINE_CATEGORIES, type MarketingPurpose } from "@beam/core/crm";
import { formatDate, formatDateTime, formatMoney, formatTime, type Locale } from "@beam/core/i18n";
import { SENSITIVE_FIELD_KEYS } from "@beam/core/privacy";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listPersonEnrolments } from "@/modules/automation/api";
import { PersonAutomationsPanel } from "@/modules/automation/ui/person-automations-panel";
import { getWellbeingJourney, listPersonBookings, listOpenOffersForPerson } from "@/modules/booking/api";
import { WellbeingProfile } from "@/modules/booking/ui/admin/wellbeing-profile";
import { getPersonActivity, getPersonAssistantPanel, getPersonBehaviourPanel } from "@/modules/assistant/api";
import { ActivityPanel } from "@/modules/assistant/ui/admin/activity-panel";
import { BehaviourPanel } from "@/modules/assistant/ui/admin/behaviour-panel";
import { AssistantPersonPanel } from "@/modules/assistant/ui/admin/person-panel";
import { getPersonOpenAccount, listPersonOrders } from "@/modules/commerce/api";
import { PersonOpenAccount } from "@/modules/commerce/ui/person-open-account";
import { getPersonCreditSummary } from "@/modules/credits/api";
import { PersonMembershipPanel } from "@/modules/credits/ui/person-membership-panel";
import { PersonEmailHistory } from "@/modules/email/ui/PersonEmailHistory";
import { getInvoiceForOrder, listInvoicesForPerson } from "@/modules/finance/api";
import { getPersonOpportunities, getPersonStats, type Opportunity } from "@/modules/ops/api";
import { getCurrentLegalVersion } from "@/modules/site/api";
import { listStaffForAssignment } from "@/modules/platform/api";
import { PrimaryAction, Segmented, StatusPill, type Tone } from "@/modules/platform/ui/admin-kit";
import { BackLink, Notice } from "@/modules/platform/ui/admin-list-kit";
import { getPersonConsentPanel } from "@/modules/crm/consent/queries";
import { listPersonDeclarations } from "@/modules/crm/declarations/queries";
import { getPerson360, listPersonSegments } from "@/modules/crm/person360/queries";
import { listTasks, taskListLabels, toTaskView } from "@/modules/crm/tasks/queries";
import { getTimeline, toTimelineRows } from "@/modules/crm/timeline/queries";
import { ConsentPanel } from "@/modules/crm/ui/consent-panel";
import { DeclarationCard } from "@/modules/crm/ui/declaration-card";
import { PersonAvatar } from "@/modules/crm/ui/kit";
import { PersonActionsMenu, type PersonMenuItem } from "@/modules/crm/ui/person-360/actions-menu";
import { ActionBlock, InteractionForm, NoteForm, PersonFacts } from "@/modules/crm/ui/person-360/header";
import { OverrideBanner, StatusOverrideForm } from "@/modules/crm/ui/person-360/override-banner";
import {
  ActivityList,
  ContactLinks,
  CreditMeter,
  DeskAlerts,
  FollowUpList,
  KpiEmpty,
  KpiValue,
  ProfileKpis,
  VisitList,
  VisitsStrip,
  visitsByMonth,
  type Action,
  type DeskAlert,
  type FollowUp,
  type ProfileKpi,
  type VisitRowView,
} from "@/modules/crm/ui/person-360/profile";
import { Panel, PanelTable, type PanelRow } from "@/modules/crm/ui/person-360/panels";
import { receptionCardLabels } from "@/modules/crm/ui/person-360/reception-card";
import { NotAvailable, safePanel, type SafeResult } from "@/modules/crm/ui/person-360/safe-panel";
import { SensitivePanel } from "@/modules/crm/ui/sensitive-panel";
import { TaskList } from "@/modules/crm/ui/task-list";
import { Timeline } from "@/modules/crm/ui/timeline/timeline";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS = ["overview", "bookings", "packages", "payments", "timeline", "details"] as const;
type Tab = (typeof TABS)[number];
const NEW_DAYS = 30;

const rowsOr = <T,>(r: SafeResult<T[]>, map: (v: T) => PanelRow): PanelRow[] | null => (r.ok ? r.value.map(map) : null);
const textOf = (v: Record<string, string | undefined> | null | undefined, locale: Locale): string => (v ? (v[locale] ?? Object.values(v).find(Boolean) ?? "") : "");
/** A panel that only the given tab shows loads only there. */
const when = <T,>(load: boolean, run: () => Promise<T>): Promise<SafeResult<T>> => (load ? safePanel(run) : Promise.resolve({ ok: false }));

const BOOKING_TONE: Record<string, Tone> = { confirmed: "ok", reserved: "warn", attended: "muted", cancelled: "muted", late_cancelled: "bad", no_show: "bad" };
const ORDER_TONE: Record<string, Tone> = { paid: "ok", pending_payment: "warn", draft: "muted", cancelled: "muted", expired: "muted", refunded: "info", partially_refunded: "info" };
const INVOICE_TONE: Record<string, Tone> = { paid: "ok", open: "warn", issued: "info", cancelled: "muted" };
const ENROLMENT_TONE: Record<string, Tone> = { active: "ok", completed: "muted", exited: "muted" };

/**
 * `/admin/persons/[id]`, the customer 360 (`persons.read`; each action its own permission), crm
 * spec 5.1, as a detail page in the back-office kit (owner review, November 2026): the header
 * (avatar, name, number, quick-contact links and a few pills) with one primary "Boeken"
 * (`bookings.write`) and a "⋯" menu (edit, sell at the till, new task, merge, each with its own
 * permission); one banner with the reception warnings (house rules, health declaration, guardian
 * consent, open balance, past-due membership), each with its action; a KPI row (next visit,
 * credits per kind, membership, spent, open balance) whose empty cells are a muted line with an
 * action; then tabs (`?tab=`): overview (next visits, the dashboard's follow-up opportunities,
 * recent activity; key facts, tags, open tasks, the open account and a visit strip), bookings
 * (with the wellbeing check-ins for `persons.sensitive_read`), packages and membership, payments
 * and invoices, the timeline (note and contact log, timeline, automations, emails, the assistant
 * panels) and data and consents (status override, consents, guardian consent, sensitive data,
 * segments). Each foreign panel loads through `safePanel()` and only on its tab. A merged id
 * redirects to its winner.
 */
export default async function Person360Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; task?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getAppDb();
  const data = await getPerson360(db, id);
  if (!data) notFound();
  const sp = await searchParams;
  const wanted = sp.tab;
  const tab: Tab = (TABS as readonly string[]).includes(wanted ?? "") ? (wanted as Tab) : "overview";
  if (data.redirectTo && data.redirectTo !== id) redirect(`/admin/persons/${data.redirectTo}${tab === "overview" ? "" : `?tab=${tab}`}` as never);

  const locale = await adminLocale();
  const tr = translator(locale);
  const h = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.header.${k}`, p);
  const pl = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.panels.${k}`, p);
  const a = (k: string) => tr(`crm.person360.actions.${k}`);
  const col = (k: string) => tr(`crm.person360.cols.${k}`);
  const kp = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.kpi.${k}`, p);
  const ov = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.overview.${k}`, p);
  const al = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.alerts.${k}`, p);
  const fu = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.followup.${k}`, p);
  const na = pl("not_available");
  const none = tr("crm.common.none");
  const canWrite = hasPermission(actor, "persons.write");
  const canSensitive = hasPermission(actor, "persons.sensitive_read");
  const canMerge = hasPermission(actor, "persons.merge");
  const canAllTasks = hasPermission(actor, "tasks.all");
  const canBook = hasPermission(actor, "bookings.write");
  const canAssistant = hasPermission(actor, "assistant.read");
  const canSell = hasPermission(actor, "commerce.sell");
  const { person, status } = data;
  const statusLabel = (s: string) => tr(`crm.enums.person_status.${s}`);
  const date = (d: Date | string | null | undefined) => (d ? formatDate(d, locale) : null);
  const money = (cents: number) => formatMoney(cents, locale);
  const now = new Date();
  const is = (...t: Tab[]) => t.includes(tab);

  const [credits, stats, invoices, bookings, opportunities, recent, offers, orders, tasks, staff, enrolments, emails, automationsNode, timeline, segmentsOfPerson, consent, declarations, guardianVersion] = await Promise.all([
    safePanel(() => getPersonCreditSummary(db, person.id)),
    safePanel(() => getPersonStats(db, person.id)),
    safePanel(() => listInvoicesForPerson(db, person.id)),
    // ponytail: the latest 200 bookings feed the next visit, the bookings tab and the 12-month strip; page it if a client books more.
    safePanel(() => listPersonBookings(db, person.id, { limit: 200 })),
    safePanel(() => getPersonOpportunities(db, { personId: person.id, now })),
    when(is("overview"), async () => toTimelineRows(db, (await getTimeline(db, { personId: person.id, limit: 5 })).items, locale)),
    when(is("overview", "bookings"), () => listOpenOffersForPerson(db, person.id)),
    when(is("payments"), () => listPersonOrders(db, person.id, { limit: 20 })),
    when(is("overview"), () => listTasks(db, { userId: actor.userId, scope: canAllTasks ? "all" : "mine", personId: person.id, status: "open" })),
    when(is("overview"), () => listStaffForAssignment(db, { permission: "persons.read" })),
    when(is("timeline"), () => listPersonEnrolments(db, person.id)),
    when(is("timeline"), () => Promise.resolve<ReactNode>(PersonEmailHistory({ personId: person.id }))),
    when(is("timeline"), () => Promise.resolve<ReactNode>(PersonAutomationsPanel({ personId: person.id }))),
    when(is("timeline"), async () => {
      const page = await getTimeline(db, { personId: person.id, limit: 50 });
      return { rows: await toTimelineRows(db, page.items, locale), next: page.nextBefore ? { occurredAt: page.nextBefore.occurredAt.toISOString(), id: page.nextBefore.id } : null };
    }),
    when(is("details"), () => listPersonSegments(db, person.id)),
    when(is("details"), () => getPersonConsentPanel(db, person.id)),
    when(is("details"), () => listPersonDeclarations(db, person.id)),
    when(is("details"), () => getCurrentLegalVersion(db, "guardian_consent")),
  ]);
  const [wellbeing, assistantPanel, behaviour, activity] = await Promise.all([
    when(is("bookings") && canSensitive, () => getWellbeingJourney(db, person.id)),
    when(is("timeline") && canAssistant, () => getPersonAssistantPanel(db, person.id)),
    when(is("timeline") && canAssistant, () => getPersonBehaviourPanel(db, person.id)),
    when(is("timeline") && canAssistant, () => getPersonActivity(db, person.id)),
  ]);

  const addr = person.address;
  const address = addr ? [[addr.street, addr.number, addr.box].filter(Boolean).join(" "), [addr.postal_code, addr.city].filter(Boolean).join(" "), addr.country].filter(Boolean).join(", ") : null;
  const acq = person.acquisition as { source?: string; campaign?: string; captured_at?: string };
  const reception = receptionCardLabels(tr);
  const onboarding = person.onboarding ? onboardingProgress(person.onboarding) : null;
  const onboardingLabel = !onboarding
    ? null
    : person.onboarding?.dismissed_at && onboarding.next
      ? h("onboarding_dismissed", { answered: onboarding.answered, total: onboarding.total })
      : h("onboarding_progress", { answered: onboarding.answered, total: onboarding.total });
  const isNew = now.getTime() - person.createdAt.getTime() < NEW_DAYS * 86_400_000;
  const tabHref = (t: Tab) => (t === "overview" ? `/admin/persons/${person.id}` : `/admin/persons/${person.id}?tab=${t}`) as Route;

  const erased = !!person.erasedAt;
  const bookHref = `/admin/bookings/new?personId=${person.id}`;
  const sellHref = `/admin/pos?personId=${person.id}`;
  const bookAction = (label: string): Action | null => (canBook && !erased ? { href: bookHref, label } : null);
  const sellAction = (label: string): Action | null => (canSell && !erased ? { href: sellHref, label } : null);
  const brussels = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", ...o }).format(d);
  const dash = "–";

  const stat = stats.ok ? stats.value : null;
  const membership = credits.ok ? credits.value.membership : null;
  const pastDue = membership?.status === "past_due";
  const client = opportunities.ok ? (opportunities.value?.client ?? null) : null;
  const openInvoices = invoices.ok ? invoices.value.filter((i) => i.kind === "invoice" && i.status === "open") : [];
  // Orders "op rekening" count too, unless they already have an (open) invoice counted above.
  const onAccount = await getPersonOpenAccount(db, person.id).catch(() => null);
  const uninvoiced = onAccount ? (await Promise.all(onAccount.orders.map(async (o) => ((await getInvoiceForOrder(db, o.orderId))?.status === "open" ? 0 : o.dueCents)))) : [];
  const openCents = openInvoices.reduce((s, i) => s + i.totalCents, 0) + uninvoiced.reduce((s, c) => s + c, 0);

  // Reception warnings: what blocks or needs the desk before the visit.
  const decl = data.reception.declarations;
  const deskMissing: DeskAlert[] = [
    ...(decl.termsAccepted ? [] : [{ key: "terms", tone: "bad" as const, text: reception.termsMissing }]),
    ...(decl.healthDeclarationValid ? [] : [{ key: "health", tone: "bad" as const, text: reception.healthMissing, action: canWrite && !erased ? { href: `/admin/forms/enter?personId=${person.id}`, label: al("fill_health") } : null }]),
    ...(data.reception.isMinor && !decl.guardianConsentValid ? [{ key: "guardian", tone: "bad" as const, text: reception.guardianMissing, action: canWrite && !erased ? { href: tabHref("details"), label: al("record_guardian") } : null }] : []),
  ];
  const alerts: DeskAlert[] = erased
    ? []
    : [
        ...deskMissing,
        ...(openCents > 0 ? [{ key: "balance", tone: "warn" as const, text: al("open_balance", { amount: money(openCents) }), action: { href: tabHref("payments"), label: al("view") } }] : []),
        ...(pastDue ? [{ key: "past_due", tone: "warn" as const, text: al("past_due"), action: { href: tabHref("packages"), label: al("view") } }] : []),
      ];

  // The KPI row: next visit, credits, membership, spent and the open balance; an empty cell is a muted line with its action.
  const live = (b: { status: string; startsAt: Date }) => b.startsAt.getTime() > now.getTime() && (b.status === "confirmed" || b.status === "reserved");
  const upcoming = bookings.ok ? bookings.value.filter(live).sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime()) : [];
  const next = upcoming[0];
  const whenLabel = (d: Date) => `${brussels(d, { weekday: "short", day: "numeric", month: "short" })} · ${formatTime(d, locale)}`;
  const lastVisit = stat?.lastVisitAt ? kp("last_visit_on", { date: date(stat.lastVisitAt) ?? "" }) : null;
  const packs = client
    ? client.packages.filter((p) => p.total > 0).map((p) => ({ kind: p.kind, remaining: p.remaining, total: p.total, expires: p.remaining > 0 ? p.nextExpiresAt : null }))
    : credits.ok
      ? credits.value.byKind.filter((k) => k.kind !== "euro" && k.remainingUnits > 0).map((k) => ({ kind: k.kind, remaining: k.remainingUnits, total: null as number | null, expires: k.nextExpiresAt }))
      : [];
  const freeUnits = client?.membership?.freeLeft.reduce((s, f) => s + f.units, 0) ?? 0;
  const euro = credits.ok ? (credits.value.byKind.find((k) => k.kind === "euro")?.remainingUnits ?? 0) : 0;
  const memberEnds = client?.membership?.endsAt ?? membership?.periodEndAt ?? null;

  const kpis: ProfileKpi[] = [
    {
      key: "next_visit",
      label: kp("next_visit"),
      href: tabHref("bookings"),
      body: !bookings.ok ? (
        <KpiValue value={dash} />
      ) : next ? (
        <KpiValue value={<span className="first-letter:uppercase">{whenLabel(next.startsAt)}</span>} sub={textOf(next.title, locale)} />
      ) : (
        <>
          <KpiEmpty text={kp("nothing_planned")} action={bookAction(kp("book"))} />
          {lastVisit ? <span className="text-[0.75rem] text-muted-foreground">{lastVisit}</span> : null}
        </>
      ),
    },
    {
      key: "credits",
      label: kp("credits"),
      href: tabHref("packages"),
      body:
        !credits.ok && !client ? (
          <KpiValue value={dash} />
        ) : packs.length || freeUnits || euro ? (
          <span className="grid gap-1.5">
            {packs.map((p) => (
              <CreditMeter key={p.kind} label={kp(`credit_${p.kind}`)} remaining={p.remaining} total={p.total} sub={p.expires ? kp("expires_short", { date: date(p.expires) ?? "" }) : null} />
            ))}
            {euro ? (
              <span className="flex items-baseline justify-between gap-2 text-[0.8125rem]">
                <span className="text-muted-foreground">{kp("credit_euro")}</span>
                <span className="font-semibold tabular-nums">{money(euro)}</span>
              </span>
            ) : null}
            {freeUnits ? <span className="text-[0.75rem] text-muted-foreground">{kp("free_member", { count: freeUnits })}</span> : null}
          </span>
        ) : (
          <KpiEmpty text={kp("no_package")} action={sellAction(kp("sell_package"))} />
        ),
    },
    {
      key: "membership",
      label: kp("membership"),
      href: tabHref("packages"),
      body: !credits.ok ? (
        <KpiValue value={dash} />
      ) : membership ? (
        <KpiValue
          value={memberEnds ? kp("member_until", { date: date(memberEnds) ?? "" }) : dash}
          tone={pastDue ? "bad" : undefined}
          sub={[textOf(membership.planName, locale), pastDue ? kp("past_due") : client?.membership ? kp(client.membership.renews ? "renews" : "ends") : null].filter(Boolean).join(" · ")}
        />
      ) : (
        <KpiEmpty text={kp("no_membership")} action={sellAction(kp("sell_membership"))} />
      ),
    },
    {
      key: "spent",
      label: kp("spent"),
      href: tabHref("payments"),
      body: !stat ? (
        stats.ok ? <KpiEmpty text={kp("nothing_spent")} /> : <KpiValue value={dash} />
      ) : stat.revenueCents > 0 ? (
        <KpiValue value={money(stat.revenueCents)} sub={stat.visits ? kp("spent_sub", { visits: stat.visits, avg: money(Math.round(stat.revenueCents / stat.visits)) }) : kp("purchases", { count: stat.purchases })} />
      ) : (
        <KpiEmpty text={kp("nothing_spent")} />
      ),
    },
    {
      key: "balance",
      label: kp("open"),
      href: tabHref("payments"),
      body: !invoices.ok ? (
        <KpiValue value={dash} />
      ) : openCents > 0 ? (
        <KpiValue
          value={money(openCents)}
          tone="warn"
          sub={[openInvoices.length ? kp("open_invoices", { count: openInvoices.length }) : null, onAccount?.orders.length ? tr("commerce.open_account.short", { count: onAccount.orders.length }) : null].filter(Boolean).join(" · ")}
        />
      ) : (
        <KpiEmpty text={kp("nothing_open")} />
      ),
    },
  ];

  // The "⋯" menu: every secondary action, each behind its own permission.
  const menu: PersonMenuItem[] = [
    ...(canWrite ? [{ key: "edit", href: `/admin/persons/${person.id}/edit`, label: a("edit") }] : []),
    ...(canSell && !erased ? [{ key: "sell", href: sellHref, label: a("sell_pos") }] : []),
    ...(!erased ? [{ key: "task", href: `/admin/persons/${person.id}?task=new`, label: a("new_task") }] : []),
    ...(canMerge ? [{ key: "merge", href: "/admin/persons/duplicates", label: a("merge_with"), separated: true }] : []),
  ];

  // Overview: next visits, follow-up (the dashboard's opportunities), recent activity, visit strip.
  const visitRow = (b: (typeof upcoming)[number]): VisitRowView => ({
    id: b.bookingId,
    href: `/admin/bookings/${b.bookingId}`,
    weekday: brussels(b.startsAt, { weekday: "short" }).replace(/\.$/, ""),
    day: brussels(b.startsAt, { day: "numeric" }),
    month: brussels(b.startsAt, { month: "long" }),
    time: formatTime(b.startsAt, locale),
    title: textOf(b.title, locale),
    meta: [tr(`booking.kind.${b.kind}`), b.isGuest ? col("guest") : null].filter(Boolean).join(" · "),
    pill: b.status === "reserved" ? { tone: "warn", label: tr(`booking.status.${b.status}`) } : null,
  });
  const followUp = (o: Opportunity): FollowUp => {
    const key = `${o.key}${o.kind ? `:${o.kind}` : ""}`;
    const on = date(o.date) ?? "";
    if (o.key === "first_visit") return { key, text: fu("first_visit"), action: canWrite && !erased ? { href: tabHref("timeline"), label: a("add_note") } : null };
    if (o.key === "package_low") return { key, text: fu(o.units ? "package_low" : "package_used_up", { kind: o.kind ?? "day" }), action: sellAction(fu("sell_package")) };
    if (o.key === "package_expiring") return { key, text: fu("package_expiring", { units: o.units ?? 0, date: on }), action: bookAction(ov("book_session")) };
    if (o.key === "membership_renewal") return { key, text: fu("membership_renewal", { date: on }), action: { href: tabHref("packages"), label: fu("view_membership") } };
    return { key, text: fu("free_session_unused", { units: o.units ?? 0 }), action: bookAction(ov("book_session")) };
  };
  const months = bookings.ok
    ? visitsByMonth(
        bookings.value.filter((b) => b.status === "attended" && !b.isGuest).map((b) => b.startsAt),
        now,
        locale,
      )
    : [];
  const monthName = (key: string) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${key}-15T12:00:00Z`));
  const whatsapp = normalisePhone(person.phone)?.slice(1) ?? null;

  const staffList = staff.ok ? staff.value : [];
  const self = staffList.find((s) => s.userId === actor.userId);
  const owners = canAllTasks ? staffList.map((s) => ({ value: s.userId, label: s.name })) : [{ value: actor.userId, label: self?.name ?? tr("crm.tasks.tab_mine") }];

  const purposeLabel = (p: string) => tr(`crm.enums.consent_purpose.${p}`);
  const c = (k: string) => tr(`crm.consentPanel.${k}`);
  const latestDecl = declarations.ok ? (declarations.value[0] ?? null) : null;
  const v = (k: string) => tr(`crm.person360.timeline_ui.${k}`);

  const bookingRow = (b: Awaited<ReturnType<typeof listPersonBookings>>[number]): PanelRow => ({
    id: b.bookingId,
    href: `/admin/bookings/${b.bookingId}`,
    cells: {
      date: <span className="whitespace-nowrap first-letter:uppercase">{formatDateTime(b.startsAt, locale)}</span>,
      session: (
        <span className="grid leading-tight">
          <span>{textOf(b.title, locale)}</span>
          {b.isGuest ? <span className="text-[0.75rem] text-muted-foreground">{col("guest")}</span> : null}
        </span>
      ),
      kind: tr(`booking.kind.${b.kind}`),
    },
    pill: { tone: BOOKING_TONE[b.status] ?? "muted", label: tr(`booking.status.${b.status}`) },
  });
  const offerRows = rowsOr(offers, (o) => ({ id: o.entryId, cells: { session: textOf(o.title, locale), date: date(o.startsAt), until: date(o.offerExpiresAt) } }));
  const offerColumns = [
    { key: "session", label: col("session") },
    { key: "date", label: col("date"), className: "w-36" },
    { key: "until", label: col("offer_until"), className: "w-36" },
  ];

  return (
    <div className="grid gap-4" data-testid="person-360">
      {status.showConflictBanner && status.override ? (
        <OverrideBanner
          personId={person.id}
          labels={{
            message: tr("crm.person360.banners.override_conflict", { override: statusLabel(status.override), derived: statusLabel(status.derivedStatus) }),
            keep: tr("crm.person360.banners.keep"),
            clear: tr("crm.person360.banners.clear_override"),
            reason: a("override_reason"),
            error: tr("crm.common.error"),
          }}
        />
      ) : null}

      <BackLink href="/admin/persons">{tr("crm.persons.list.title")}</BackLink>
      <header data-testid="person-header" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <PersonAvatar id={person.id} name={person.name} className="size-12 text-[0.9375rem]" />
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="min-w-0 truncate">{person.name || "—"}</h1>
              <StatusPill tone={status.status === "member" ? "ok" : status.status === "lead" ? "info" : "muted"} className={status.override ? "ring-1 ring-current ring-inset" : undefined}>
                <span data-testid="person-status" title={status.override ? [h("status_override", { status: statusLabel(status.override) }), h("status_derived", { status: statusLabel(status.derivedStatus) })].join(" · ") : undefined}>
                  {statusLabel(status.status)}
                </span>
              </StatusPill>
              {status.isMember && status.status !== "member" ? <StatusPill tone="ok">{h("member")}</StatusPill> : null}
              {data.isCorporate ? (
                <StatusPill tone="gold">
                  <span data-testid="person-corporate">{h("corporate")}</span>
                </StatusPill>
              ) : null}
              {data.reception.isMinor ? <StatusPill tone="warn">{h("minor")}</StatusPill> : null}
              {isNew ? <StatusPill tone="info">{h("new")}</StatusPill> : null}
              {person.isTester ? <StatusPill tone="muted">{h("tester")}</StatusPill> : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem] text-muted-foreground">
              <span className="tabular-nums">{h("customer_number", { customerNumber: person.customerNumber })}</span>
              <ContactLinks email={person.email} phone={person.phone} whatsapp={whatsapp} labels={{ email: h("contact_email"), call: h("contact_call"), whatsapp: h("contact_whatsapp") }} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canBook && !erased ? <PrimaryAction href={bookHref as Route}>{a("book_short")}</PrimaryAction> : null}
          <PersonActionsMenu label={h("more_actions")} items={menu} />
        </div>
      </header>

      {person.erasedAt ? <Notice tone="bad">{tr("crm.person360.banners.erased")}</Notice> : null}
      {person.processingRestrictedAt ? <Notice tone="warn">{tr("crm.person360.banners.restricted")}</Notice> : null}
      <DeskAlerts title={al("title")} items={alerts} />

      <ProfileKpis label={pl("kpis")} items={kpis} />

      <div className="overflow-x-auto">
        <Segmented label={tr("crm.person360.tabs.label")} items={TABS.map((t) => ({ key: t, label: tr(`crm.person360.tabs.${t}`), href: tabHref(t), active: t === tab }))} />
      </div>

      {tab === "overview" ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid gap-4">
            <Panel title={ov("next_visits")} testId="panel-bookings" flush action={{ href: tabHref("bookings"), label: pl("all_bookings") }}>
              {bookings.ok ? (
                <VisitList rows={upcoming.slice(0, 5).map(visitRow)} empty={<KpiEmpty text={ov("nothing_planned")} action={bookAction(ov("book_session"))} />} />
              ) : (
                <div className="px-5 py-4">
                  <NotAvailable label={na} />
                </div>
              )}
            </Panel>
            {offers.ok && offers.value.length ? (
              <Panel title={pl("waitlist")} testId="panel-waitlist" flush>
                <PanelTable caption={pl("waitlist")} columns={offerColumns} rows={offerRows} empty={none} notAvailable={na} />
              </Panel>
            ) : null}
            <Panel title={ov("followup")} testId="panel-followup" flush>
              {opportunities.ok && opportunities.value ? (
                <FollowUpList items={opportunities.value.opportunities.map(followUp)} empty={ov("followup_none")} />
              ) : (
                <div className="px-5 py-3">
                  <NotAvailable label={na} />
                </div>
              )}
            </Panel>
            <Panel title={ov("recent")} testId="panel-recent" flush action={{ href: tabHref("timeline"), label: ov("full_timeline") }}>
              {recent.ok ? (
                <ActivityList rows={recent.value.map((r) => ({ id: r.id, occurredAt: r.occurredAt, time: r.timeLabel, category: r.categoryLabel, summary: r.summary }))} empty={ov("recent_empty")} />
              ) : (
                <div className="px-5 py-3">
                  <NotAvailable label={na} />
                </div>
              )}
            </Panel>
          </div>
          <div className="grid content-start gap-4">
          <PersonFacts
            view={{
              email: person.email,
              phone: person.phone,
              address,
              localeLabel: tr(`crm.enums.locale.${person.locale.replace("-", "_")}`),
              birthOn: date(person.birthOn),
              preferredChannel: person.preferredChannel ? tr(`crm.enums.preferred_channel.${person.preferredChannel}`) : null,
              onboarding: onboardingLabel,
              acquisition: {
                source: acq.source ? tr(`crm.enums.acquisition_source.${acq.source}`) : null,
                campaign: acq.campaign ?? null,
                date: acq.captured_at ? h("acquired_on", { date: date(acq.captured_at) ?? "" }) : null,
              },
              partner: person.partnerCompany,
              companies: data.companies.map((co) => ({ id: co.companyId, name: co.name, position: co.position })),
              tags: data.tags.map((t) => ({ key: t.key, label: textOf(t.name, locale) || t.key, color: t.color })),
              emergencyContact: person.emergencyContact,
              desk: { ok: deskMissing.length === 0, label: deskMissing.length ? al("desk_open", { count: deskMissing.length }) : al("desk_ok") },
            }}
            labels={{
              title: pl("facts"),
              email: h("email"),
              phone: h("phone"),
              address: h("address"),
              preferredChannel: h("preferred_channel"),
              onboarding: h("onboarding"),
              locale: h("locale"),
              acquisition: h("acquisition"),
              campaign: h("acquisition_campaign"),
              partner: h("partner"),
              companies: h("companies"),
              emergencyContact: h("emergency_contact"),
              noEmergencyContact: h("no_emergency_contact"),
              tags: a("tag"),
              birthOn: h("birth_on"),
              desk: h("desk"),
            }}
          />
            <section aria-labelledby="tasks-heading" className="overflow-hidden rounded-xl border border-border bg-card">
              {tasks.ok ? (
                <TaskList
                  tasks={tasks.value.map((t) => toTaskView(t, locale, tr))}
                  currentUserId={actor.userId}
                  canAssignOthers={canAllTasks}
                  owners={owners}
                  personId={person.id}
                  labels={taskListLabels(tr)}
                  dense={{ title: pl("tasks"), headingId: "tasks-heading" }}
                  openCreate={sp.task === "new"}
                />
              ) : (
                <div className="grid gap-2 px-5 py-3">
                  <h2 id="tasks-heading" className="text-[0.875rem] font-semibold">
                    {pl("tasks")}
                  </h2>
                  <NotAvailable label={na} />
                </div>
              )}
            </section>
            <PersonOpenAccount personId={person.id} locale={locale} />
            {months.length ? (
              <div className="rounded-xl border border-border bg-card px-5 py-4">
                <VisitsStrip
                  label={[ov("visits_strip"), stat?.noShows ? kp("no_shows", { count: stat.noShows }) : null].filter(Boolean).join(" · ")}
                  months={months}
                  title={(m) => ov("visits_month", { month: monthName(m.key), count: m.count })}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "bookings" ? (
        <div className="grid gap-4">
          <Panel title={pl("bookings")} testId="panel-bookings" flush>
            <PanelTable
              caption={pl("bookings")}
              columns={[
                { key: "date", label: col("date"), className: "w-48" },
                { key: "session", label: col("session") },
                { key: "kind", label: col("kind"), className: "w-28" },
                { key: "pill", label: col("status"), className: "w-36" },
              ]}
              rows={bookings.ok ? bookings.value.slice(0, 50).map(bookingRow) : null}
              empty={none}
              notAvailable={na}
            />
          </Panel>
          <Panel title={pl("waitlist")} testId="panel-waitlist" flush>
            <PanelTable caption={pl("waitlist")} columns={offerColumns} rows={offerRows} empty={none} notAvailable={na} />
          </Panel>
          {wellbeing.ok ? <WellbeingProfile journey={wellbeing.value} tr={tr} locale={locale} /> : null}
        </div>
      ) : null}

      {tab === "packages" ? (
        <div className="grid items-start gap-4 md:grid-cols-2">
          <Panel title={pl("credits")} testId="panel-credits" flush action={{ href: `/admin/credits?person=${person.id}`, label: pl("all_packages") }}>
            <PanelTable
              caption={pl("credits")}
              columns={[
                { key: "kind", label: col("kind") },
                { key: "remaining", label: col("remaining"), align: "right", className: "w-28" },
                { key: "expires", label: col("expires"), className: "w-36" },
              ]}
              rows={credits.ok ? credits.value.byKind.map((k) => ({ id: k.kind, cells: { kind: tr(`crm.person360.credit_kinds.${k.kind}`), remaining: <span className="font-semibold">{k.kind === "euro" ? money(k.remainingUnits) : k.remainingUnits}</span>, expires: date(k.nextExpiresAt) ?? dash } })) : null}
              empty={none}
              notAvailable={na}
            />
          </Panel>
          <PersonMembershipPanel personId={person.id} locale={locale} />
        </div>
      ) : null}

      {tab === "payments" ? <PersonOpenAccount personId={person.id} locale={locale} /> : null}
      {tab === "payments" ? (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Panel title={pl("orders")} testId="panel-orders" flush>
            <PanelTable
              caption={pl("orders")}
              columns={[
                { key: "reference", label: col("reference") },
                { key: "date", label: col("date"), className: "w-32" },
                { key: "total", label: col("total"), align: "right", className: "w-28" },
                { key: "pill", label: col("status"), className: "w-32" },
              ]}
              rows={rowsOr(orders, (o) => ({
                id: o.orderId,
                href: `/admin/orders/${o.orderId}`,
                cells: { reference: o.reference, date: date(o.paidAt ?? o.createdAt), total: <span className="font-semibold">{money(o.totalCents)}</span> },
                pill: { tone: ORDER_TONE[o.status] ?? "muted", label: tr(`commerce.order_status.${o.status}`) },
              }))}
              empty={none}
              notAvailable={na}
            />
          </Panel>
          <Panel title={pl("invoices")} testId="panel-invoices" flush>
            <PanelTable
              caption={pl("invoices")}
              columns={[
                { key: "number", label: col("number") },
                { key: "date", label: col("date"), className: "w-32" },
                { key: "total", label: col("total"), align: "right", className: "w-28" },
                { key: "pill", label: col("status"), className: "w-28" },
              ]}
              rows={rowsOr(invoices, (i) => ({
                id: i.id,
                href: `/admin/finance/invoices/${i.id}`,
                cells: { number: i.number, date: date(i.issuedOn), total: <span className="font-semibold">{money(i.totalCents)}</span> },
                pill: i.kind === "credit_note" ? { tone: "info", label: col("credit_note") } : { tone: INVOICE_TONE[i.status] ?? "muted", label: tr(`finance.admin.status.${i.status}`) },
              }))}
              empty={none}
              notAvailable={na}
            />
          </Panel>
        </div>
      ) : null}

      {tab === "timeline" ? (
        <div className="grid gap-4">
          {canWrite && !person.erasedAt ? (
            <div className="grid gap-3 md:grid-cols-2">
              <ActionBlock title={a("add_note")} testId="action-note">
                <NoteForm
                  personId={person.id}
                  canSensitive={canSensitive}
                  labels={{ title: a("add_note"), body: a("note_body"), sensitive: a("note_sensitive"), save: tr("crm.common.save"), saved: tr("crm.common.saved"), error: tr("crm.common.error") }}
                />
              </ActionBlock>
              <ActionBlock title={a("log_interaction")} testId="action-interaction">
                <InteractionForm
                  personId={person.id}
                  labels={{
                    title: a("log_interaction"),
                    channel: a("interaction_channel"),
                    purpose: a("interaction_purpose"),
                    summary: a("interaction_summary"),
                    occurredAt: a("interaction_occurred_at"),
                    save: tr("crm.common.save"),
                    saved: tr("crm.common.saved"),
                    error: tr("crm.common.error"),
                    channels: Object.fromEntries(["call", "email", "whatsapp", "in_person", "meeting", "other"].map((k) => [k, tr(`crm.enums.interaction_channel.${k}`)])),
                    purposes: Object.fromEntries(["service", "sales_follow_up", "reactivation", "b2b"].map((k) => [k, tr(`crm.enums.interaction_purpose.${k}`)])),
                  }}
                />
              </ActionBlock>
            </div>
          ) : null}

          {timeline.ok ? (
            <Timeline
              personId={person.id}
              initialRows={timeline.value.rows}
              initialNext={timeline.value.next}
              chips={TIMELINE_CATEGORIES.map((k) => ({ key: k, label: tr(`crm.timeline.categories.${k}`) }))}
              canReveal={canSensitive}
              labels={{
                title: tr("crm.timeline.title"),
                empty: tr("crm.timeline.empty"),
                loadMore: tr("crm.timeline.load_more"),
                sensitiveNote: tr("crm.timeline.sensitive_note"),
                reveal: tr("crm.timeline.reveal"),
                all: v("all"),
                error: tr("crm.common.error"),
                loading: tr("crm.common.loading"),
              }}
            />
          ) : (
            <Panel title={tr("crm.timeline.title")}>
              <NotAvailable label={na} />
            </Panel>
          )}

          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Panel title={pl("automations")} testId="panel-automations" flush>
              <PanelTable
                caption={pl("automations")}
                columns={[
                  { key: "name", label: col("automation") },
                  { key: "next", label: col("next_step"), className: "w-44" },
                  { key: "pill", label: col("status"), className: "w-28" },
                ]}
                rows={rowsOr(enrolments, (e) => ({
                  id: e.enrolmentId,
                  cells: { name: e.automationName, next: e.nextStepAt ? `${e.nextStepKey ?? ""} · ${date(e.nextStepAt)}` : dash },
                  pill: { tone: ENROLMENT_TONE[e.status] ?? "muted", label: tr(`automation.enrolment_status.${e.status}`) },
                }))}
                empty={none}
                notAvailable={na}
              />
              {automationsNode.ok ? <div className="border-t border-border px-5 py-4">{automationsNode.value}</div> : null}
            </Panel>
            <Panel title={pl("emails")} testId="panel-emails">
              {emails.ok ? emails.value : <NotAvailable label={na} />}
            </Panel>
          </div>

          {activity.ok ? <ActivityPanel data={activity.value} tr={tr} locale={locale} /> : null}
          {behaviour.ok && behaviour.value.facts ? (
            <BehaviourPanel
              personId={person.id}
              facts={behaviour.value.facts}
              advice={behaviour.value.advice}
              canApply={hasPermission(actor, "automations.move_person")}
              tr={tr}
              formatDate={(d) => formatDate(d, locale)}
              formatDateTime={(d) => formatDateTime(d, locale)}
            />
          ) : null}
          {assistantPanel.ok ? <AssistantPersonPanel panel={assistantPanel.value} tr={tr} formatDate={(d) => formatDateTime(d, locale)} /> : null}
        </div>
      ) : null}

      {tab === "details" ? (
        <div className="grid gap-4">
          {canWrite && !person.erasedAt ? (
            <ActionBlock title={status.override ? a("clear_override") : a("set_override")} testId="action-override">
              <StatusOverrideForm
                personId={person.id}
                current={status.override}
                labels={{
                  title: a("set_override"),
                  status: a("set_override"),
                  none: a("clear_override"),
                  reason: a("override_reason"),
                  save: tr("crm.common.save"),
                  error: tr("crm.common.error"),
                  statuses: { lead: statusLabel("lead"), customer: statusLabel("customer"), member: statusLabel("member") },
                }}
              />
            </ActionBlock>
          ) : null}

          {consent.ok ? (
            <ConsentPanel
              view={{
                personId: person.id,
                email: person.email,
                canWrite,
                purposes: CONSENT_PURPOSES.map((p) => {
                  const cur = consent.value.current[p];
                  const reachable = (MARKETING_PURPOSES as readonly string[]).includes(p) ? consent.value.reachable[p as MarketingPurpose] : null;
                  return { purpose: p, label: purposeLabel(p), status: cur?.status ?? null, method: cur ? tr(`crm.enums.consent_method.${cur.method}`) : null, recordedAt: date(cur?.recordedAt), reachable };
                }),
                history: consent.value.history.map((r) => ({
                  id: r.id,
                  purposeLabel: purposeLabel(r.purpose),
                  statusLabel: tr(`crm.enums.consent_status.${r.status}`),
                  methodLabel: tr(`crm.enums.consent_method.${r.method}`),
                  source: r.source,
                  wordingVersion: r.wordingVersion,
                  recordedAt: date(r.recordedAt) ?? "",
                })),
                suppressions: consent.value.suppressions.map((s) => ({ id: s.id, scopeLabel: tr(`crm.enums.suppression_scope.${s.scope}`), reasonLabel: tr(`crm.enums.suppression_reason.${s.reason}`), createdAt: date(s.createdAt) ?? "" })),
              }}
              labels={{
                title: pl("consents"),
                history: pl("consent_history"),
                suppressions: pl("suppressions"),
                none,
                granted: tr("crm.enums.consent_status.granted"),
                withdrawn: tr("crm.enums.consent_status.withdrawn"),
                notRecorded: c("not_recorded"),
                reachable: c("reachable"),
                unreachable: c("unreachable"),
                grant: c("grant"),
                withdraw: c("withdraw"),
                unsubscribeAll: a("unsubscribe_all"),
                unsubscribeAllNote: c("unsubscribe_all_note"),
                error: tr("crm.common.error"),
                columns: { purpose: c("col_purpose"), status: c("col_status"), method: c("col_method"), source: c("col_source"), version: c("col_version"), date: c("col_date"), scope: c("col_scope"), reason: c("col_reason") },
              }}
            />
          ) : (
            <Panel title={pl("consents")}>
              <NotAvailable label={na} />
            </Panel>
          )}

          {declarations.ok ? (
            <DeclarationCard
              view={{
                personId: person.id,
                isMinor: data.reception.isMinor,
                isValid: data.reception.declarations.guardianConsentValid,
                latestStatus: latestDecl?.status ?? null,
                canWrite,
                publishedVersion: guardianVersion.ok && guardianVersion.value ? guardianVersion.value.version : null,
                rows: declarations.value.map((d) => ({
                  id: d.id,
                  statusLabel: tr(`crm.enums.declaration_status.${d.status}`),
                  methodLabel: tr(`crm.enums.declaration_method.${d.method}`),
                  versionLabel: tr("crm.declarations.version", { version: d.documentVersion }),
                  acceptedOn: tr("crm.declarations.accepted_on", { date: date(d.acceptedAt) ?? "" }),
                  guardianName: d.guardianName,
                })),
                guardianOptions: [],
              }}
              labels={{
                title: tr("crm.declarations.title"),
                record: tr("crm.declarations.record"),
                revoke: tr("crm.declarations.revoke"),
                revokeReason: tr("crm.declarations.revoke_reason"),
                guardian: tr("crm.declarations.guardian"),
                guardianId: tr("crm.declarations.guardian_id"),
                valid: tr("crm.declarations.valid"),
                invalid: tr("crm.declarations.invalid"),
                none: tr("crm.declarations.none"),
                nonePublished: tr("crm.declarations.none_published"),
                minorNotice: tr("crm.declarations.minor_notice"),
                reacceptance: tr("crm.declarations.reacceptance"),
                method: tr("crm.declarations.method"),
                error: tr("crm.common.error"),
              }}
            />
          ) : null}

          {canSensitive ? (
            <SensitivePanel
              view={{
                personId: person.id,
                present: data.sensitiveKeys.map((s) => ({ key: s.key, label: tr(`crm.enums.sensitive_key.${s.key}`), updated: tr("crm.person360.sensitive.updated", { date: date(s.updatedAt) ?? "" }) })),
                options: SENSITIVE_FIELD_KEYS.map((k) => ({ key: k, label: tr(`crm.enums.sensitive_key.${k}`) })),
              }}
              labels={{
                title: pl("sensitive"),
                hidden: tr("crm.person360.sensitive.hidden"),
                reveal: tr("crm.person360.sensitive.reveal"),
                empty: tr("crm.person360.sensitive.empty"),
                value: tr("crm.person360.sensitive.value"),
                key: tr("crm.person360.sensitive.key"),
                save: tr("crm.common.save"),
                clear: tr("crm.person360.sensitive.clear"),
                edit: tr("crm.common.edit"),
                cancel: tr("crm.common.cancel"),
                error: tr("crm.common.error"),
              }}
            />
          ) : null}

          <Panel title={pl("segments")} testId="panel-segments" flush>
            <PanelTable
              caption={pl("segments")}
              columns={[
                { key: "name", label: col("segment") },
                { key: "kind", label: col("kind"), className: "w-40" },
              ]}
              rows={rowsOr(segmentsOfPerson, (s) => ({ id: s.id, href: `/admin/segments/${s.id}`, cells: { name: s.name, kind: tr(`crm.enums.segment_kind.${s.kind}`) } }))}
              empty={none}
              notAvailable={na}
            />
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

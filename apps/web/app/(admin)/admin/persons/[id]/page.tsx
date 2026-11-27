import type { ReactNode } from "react";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { CONSENT_PURPOSES, MARKETING_PURPOSES, onboardingProgress, TIMELINE_CATEGORIES, type MarketingPurpose } from "@beam/core/crm";
import { formatDate, formatDateTime, formatMoney, type Locale } from "@beam/core/i18n";
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
import { listPersonOrders } from "@/modules/commerce/api";
import { getPersonCreditSummary } from "@/modules/credits/api";
import { PersonMembershipPanel } from "@/modules/credits/ui/person-membership-panel";
import { PersonEmailHistory } from "@/modules/email/ui/PersonEmailHistory";
import { listInvoicesForPerson } from "@/modules/finance/api";
import { getPersonStats } from "@/modules/ops/api";
import { getCurrentLegalVersion } from "@/modules/site/api";
import { listStaffForAssignment } from "@/modules/platform/api";
import { PageHeader, PrimaryAction, SecondaryAction, Segmented, StatusPill, type Tone } from "@/modules/platform/ui/admin-kit";
import { BackLink, KpiStrip, Notice, type Kpi } from "@/modules/platform/ui/admin-list-kit";
import { getPersonConsentPanel } from "@/modules/crm/consent/queries";
import { listPersonDeclarations } from "@/modules/crm/declarations/queries";
import { getPerson360, listPersonSegments } from "@/modules/crm/person360/queries";
import { listTasks, taskListLabels, toTaskView } from "@/modules/crm/tasks/queries";
import { getTimeline, toTimelineRows } from "@/modules/crm/timeline/queries";
import { ConsentPanel } from "@/modules/crm/ui/consent-panel";
import { DeclarationCard } from "@/modules/crm/ui/declaration-card";
import { ActionBlock, InteractionForm, NoteForm, PersonFacts } from "@/modules/crm/ui/person-360/header";
import { OverrideBanner, StatusOverrideForm } from "@/modules/crm/ui/person-360/override-banner";
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
 * (name, number, contact line and the status, corporate, tester, minor and new pills) with "Book
 * for this client" (`bookings.write`) and the quiet edit and merge links; a KPI strip (visits,
 * credits left, member until, spent, open balance); then tabs (`?tab=`): overview (key facts with
 * the desk checks, the next bookings, open waiting-list offers and the follow-up tasks), bookings
 * (with the wellbeing check-ins for `persons.sensitive_read`), packages and membership, payments
 * and invoices, the timeline (note and contact log, timeline, automations, emails, the assistant
 * panels) and data and consents (status override, consents, guardian consent, sensitive data,
 * segments). Each foreign panel loads through `safePanel()` and only on its tab. A merged id
 * redirects to its winner.
 */
export default async function Person360Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getAppDb();
  const data = await getPerson360(db, id);
  if (!data) notFound();
  const wanted = (await searchParams).tab;
  const tab: Tab = (TABS as readonly string[]).includes(wanted ?? "") ? (wanted as Tab) : "overview";
  if (data.redirectTo && data.redirectTo !== id) redirect(`/admin/persons/${data.redirectTo}${tab === "overview" ? "" : `?tab=${tab}`}` as never);

  const locale = await adminLocale();
  const tr = translator(locale);
  const h = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.header.${k}`, p);
  const pl = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.panels.${k}`, p);
  const a = (k: string) => tr(`crm.person360.actions.${k}`);
  const col = (k: string) => tr(`crm.person360.cols.${k}`);
  const kp = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.kpi.${k}`, p);
  const na = pl("not_available");
  const none = tr("crm.common.none");
  const canWrite = hasPermission(actor, "persons.write");
  const canSensitive = hasPermission(actor, "persons.sensitive_read");
  const canMerge = hasPermission(actor, "persons.merge");
  const canAllTasks = hasPermission(actor, "tasks.all");
  const canBook = hasPermission(actor, "bookings.write");
  const canAssistant = hasPermission(actor, "assistant.read");
  const { person, status } = data;
  const statusLabel = (s: string) => tr(`crm.enums.person_status.${s}`);
  const date = (d: Date | string | null | undefined) => (d ? formatDate(d, locale) : null);
  const money = (cents: number) => formatMoney(cents, locale);
  const now = new Date();
  const is = (...t: Tab[]) => t.includes(tab);

  const [credits, stats, invoices, bookings, offers, orders, tasks, staff, enrolments, emails, automationsNode, timeline, segmentsOfPerson, consent, declarations, guardianVersion] = await Promise.all([
    safePanel(() => getPersonCreditSummary(db, person.id)),
    safePanel(() => getPersonStats(db, person.id)),
    safePanel(() => listInvoicesForPerson(db, person.id)),
    when(is("overview", "bookings"), () => listPersonBookings(db, person.id, { limit: 20 })),
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

  // The KPI strip: visits, credits left, member until, spent and the open balance.
  const stat = stats.ok ? stats.value : null;
  const creditOf = (k: string) => (credits.ok ? (credits.value.byKind.find((c) => c.kind === k)?.remainingUnits ?? 0) : 0);
  const creditParts = [creditOf("day") ? tr("crm.persons.list.credits_day", { count: creditOf("day") }) : null, creditOf("night") ? tr("crm.persons.list.credits_night", { count: creditOf("night") }) : null].filter(Boolean);
  const firstExpiry = credits.ok ? credits.value.byKind.filter((c) => c.kind !== "euro" && c.remainingUnits > 0 && c.nextExpiresAt).map((c) => c.nextExpiresAt!).sort((x, y) => x.getTime() - y.getTime())[0] : undefined;
  const membership = credits.ok ? credits.value.membership : null;
  const openInvoices = invoices.ok ? invoices.value.filter((i) => i.kind === "invoice" && i.status === "open") : [];
  const openCents = openInvoices.reduce((s, i) => s + i.totalCents, 0);
  const dash = "–";
  const kpis: Kpi[] = [
    {
      key: "visits",
      label: pl("visits"),
      value: stat ? String(stat.visits) : dash,
      ...(stat?.lastVisitAt || stat?.noShows ? { sub: [stat.lastVisitAt ? kp("last_visit_on", { date: date(stat.lastVisitAt) ?? "" }) : null, stat.noShows ? kp("no_shows", { count: stat.noShows }) : null].filter(Boolean).join(" · ") } : {}),
      href: tabHref("bookings"),
    },
    { key: "credits", label: kp("credits"), value: credits.ok ? creditParts.join(" · ") || "0" : dash, ...(firstExpiry ? { sub: kp("expires_on", { date: date(firstExpiry) ?? "" }) } : {}), href: tabHref("packages") },
    {
      key: "membership",
      label: kp("membership_until"),
      value: membership ? (date(membership.periodEndAt) ?? dash) : none,
      ...(membership ? { sub: textOf(membership.planName, locale) } : {}),
      ...(membership?.status === "past_due" ? { tone: "bad" as const } : {}),
      href: tabHref("packages"),
    },
    { key: "spent", label: kp("spent"), value: stat ? money(stat.revenueCents) : dash, ...(stat ? { sub: kp("purchases", { count: stat.purchases }) } : {}), href: tabHref("payments") },
    {
      key: "balance",
      label: kp("balance"),
      value: invoices.ok ? money(openCents) : dash,
      ...(openInvoices.length ? { sub: kp("open_invoices", { count: openInvoices.length }), tone: "warn" as const } : {}),
      href: tabHref("payments"),
    },
  ];

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
  const upcoming = bookings.ok ? bookings.value.filter((b) => b.startsAt.getTime() > now.getTime() && (b.status === "confirmed" || b.status === "reserved")).sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime()) : [];
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
      <div data-testid="person-header">
        <PageHeader
          title={person.name || "—"}
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tabular-nums">{h("customer_number", { customerNumber: person.customerNumber })}</span>
              {person.email ? <span>· {person.email}</span> : null}
              {person.phone ? <span className="tabular-nums">· {person.phone}</span> : null}
              <StatusPill tone={status.status === "member" ? "ok" : status.status === "lead" ? "info" : "muted"} className={status.override ? "ring-1 ring-current ring-inset" : undefined}>
                <span data-testid="person-status" title={status.override ? h("status_derived", { status: statusLabel(status.derivedStatus) }) : undefined}>
                  {statusLabel(status.status)}
                </span>
              </StatusPill>
              {status.isMember && status.status !== "member" ? <StatusPill tone="ok">{h("member")}</StatusPill> : null}
              {data.isCorporate ? (
                <StatusPill tone="gold">
                  <span data-testid="person-corporate">{h("corporate")}</span>
                </StatusPill>
              ) : null}
              {person.isTester ? <StatusPill tone="muted">{h("tester")}</StatusPill> : null}
              {data.reception.isMinor ? <StatusPill tone="warn">{h("minor")}</StatusPill> : null}
              {isNew ? <StatusPill tone="info">{h("new")}</StatusPill> : null}
              {status.override ? <span className="text-[0.75rem]">{[h("status_override", { status: statusLabel(status.override) }), h("status_derived", { status: statusLabel(status.derivedStatus) })].join(" · ")}</span> : null}
            </span>
          }
          actions={
            <>
              {canWrite ? <SecondaryAction href={`/admin/persons/${person.id}/edit` as Route}>{a("edit")}</SecondaryAction> : null}
              {canMerge ? <SecondaryAction href="/admin/persons/duplicates">{a("merge_with")}</SecondaryAction> : null}
              {canBook && !person.erasedAt ? <PrimaryAction href={`/admin/bookings/new?personId=${person.id}` as Route}>+ {a("book")}</PrimaryAction> : null}
            </>
          }
        />
      </div>

      {person.erasedAt ? <Notice tone="bad">{tr("crm.person360.banners.erased")}</Notice> : null}
      {person.processingRestrictedAt ? <Notice tone="warn">{tr("crm.person360.banners.restricted")}</Notice> : null}

      <KpiStrip items={kpis} data-testid="kpi-strip" aria-label={pl("kpis")} />

      <div className="overflow-x-auto">
        <Segmented label={tr("crm.person360.tabs.label")} items={TABS.map((t) => ({ key: t, label: tr(`crm.person360.tabs.${t}`), href: tabHref(t), active: t === tab }))} />
      </div>

      {tab === "overview" ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid gap-4">
            <Panel title={pl("upcoming")} testId="panel-bookings" flush action={{ href: tabHref("bookings"), label: pl("all_bookings") }}>
              <PanelTable
                caption={pl("upcoming")}
                columns={[
                  { key: "date", label: col("date"), className: "w-48" },
                  { key: "session", label: col("session") },
                  { key: "kind", label: col("kind"), className: "w-28" },
                  { key: "pill", label: col("status"), className: "w-28" },
                ]}
                rows={bookings.ok ? upcoming.slice(0, 5).map(bookingRow) : null}
                empty={pl("no_upcoming")}
                notAvailable={na}
              />
            </Panel>
            {offers.ok && offers.value.length ? (
              <Panel title={pl("waitlist")} testId="panel-waitlist" flush>
                <PanelTable caption={pl("waitlist")} columns={offerColumns} rows={offerRows} empty={none} notAvailable={na} />
              </Panel>
            ) : null}
            <section className="grid gap-2" aria-labelledby="tasks-heading">
              <h2 id="tasks-heading" className="text-[0.875rem] font-semibold">
                {pl("tasks")}
              </h2>
              {tasks.ok ? (
                <TaskList tasks={tasks.value.map((t) => toTaskView(t, locale, tr))} currentUserId={actor.userId} canAssignOthers={canAllTasks} owners={owners} personId={person.id} labels={taskListLabels(tr)} compact />
              ) : (
                <NotAvailable label={na} />
              )}
            </section>
          </div>
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
              reception: data.reception,
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
              reception,
            }}
          />
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
              rows={rowsOr(bookings, bookingRow)}
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

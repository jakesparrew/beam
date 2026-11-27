import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { listSettings } from "@/modules/platform/queries";
import { PageHeader, Surface } from "@/modules/platform/ui/admin-kit";
import { NAV } from "@/registry/nav.generated";
import type { FlagKey, Permission } from "@/registry/types.generated";

type NavEntry = { key: string; labelKey: string; href: string; permission?: string; orPermission?: string; flag?: string };

/**
 * A row of the overview: a menu page (`nav`, its permission, flag and label come from the
 * generated nav), a settings key opened in the generic editor (`key`, `settings.write`; `href`
 * when the key has its own screen) or a page of its own (`href` with its `permission`).
 */
type Def = { nav: string } | { key: string; href?: string } | { id: string; href: string; permission: Permission };

/** The topics of the settings (owner review, November 2026), in the order the team looks for them. */
const GROUPS: { key: string; rows: Def[] }[] = [
  { key: "center", rows: [{ key: "company" }, { key: "support" }, { key: "business_hours", href: "/admin/sessions/rules?tab=hours" }, { key: "site" }] },
  { key: "booking", rows: [{ nav: "booking.rules" }, { nav: "booking.templates" }, { nav: "booking.exceptions" }, { key: "credits" }, { key: "referrals" }] },
  { key: "billing", rows: [{ nav: "finance.settings" }, { key: "finance" }, { key: "commerce" }, { key: "payment_provider_by_channel" }] },
  { key: "email", rows: [{ key: "email_brand" }, { key: "email_footer" }, { key: "email_config" }, { key: "warmup_schedule" }, { key: "automation_rules" }, { key: "inbox" }] },
  { key: "team", rows: [{ nav: "platform.users" }, { nav: "platform.roles" }] },
  { key: "privacy", rows: [{ nav: "ops.privacy" }, { nav: "ops.retention_policies" }, { nav: "ops.dpia" }, { key: "retention_defaults" }, { nav: "ops.imports" }, { nav: "ops.exports" }] },
  {
    key: "technical",
    rows: [
      { nav: "platform.system" },
      { nav: "platform.jobs" },
      { nav: "platform.audit" },
      { nav: "platform.incidents" },
      { nav: "platform.security" },
      { nav: "platform.go_live" },
      { nav: "platform.reports" },
      { nav: "platform.ai" },
      { nav: "platform.flags" },
      { nav: "platform.support_register" },
      { key: "ai", href: "/admin/settings/ai" },
      { id: "assistant", href: "/admin/assistant/settings", permission: "assistant.manage" },
      { key: "ads" },
    ],
  },
];

/** Keys written by the system, or edited on a screen that already has its own row. */
const NO_ROW = new Set(["last_tick_at", "automation_cursor", "go_live_gate", "security", "booking_rules", "assistant"]);

type Row = { id: string; href: string; title: string; description: string };

/**
 * `/admin/settings` (`settings.write` or `users.manage` or `flags.manage`), "Algemeen" under
 * Instellingen (owner review, November 2026): an overview instead of a list of keys. Every topic
 * (centre and contact, booking, payment and invoicing, email, team and access, privacy, technical)
 * is a block of rows; a row opens its page or the generic editor of its settings key. A row shows
 * only when the actor may open it. Technisch links the technical pages that left the menu; a
 * declared key that no topic names lands there too, so no setting is ever out of reach.
 */
export default async function SettingsIndexPage() {
  const actor = await requireStaff();
  if (!hasPermission(actor, "settings.write") && !hasPermission(actor, "users.manage") && !hasPermission(actor, "flags.manage")) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const t = (k: string) => tr(`platform.settings.${k}`);
  const canSettings = hasPermission(actor, "settings.write");
  const declared = canSettings ? (await listSettings(await getAppDb())).filter((s) => !s.isSystem) : [];
  const declaredKeys = new Set(declared.map((s) => s.key));
  const nav = new Map((NAV.admin as readonly NavEntry[]).map((e) => [e.key, e]));
  const may = async (e: NavEntry) =>
    (!e.permission || hasPermission(actor, e.permission as Permission) || (!!e.orPermission && hasPermission(actor, e.orPermission as Permission))) &&
    (!e.flag || (await flag(e.flag as FlagKey, actor).catch(() => false)));
  /** The catalogue text, or `fallback` while a key has none. */
  const text = (key: string, fallback: string) => (soft(key) === key ? fallback : soft(key));

  const named = new Set(GROUPS.flatMap((g) => g.rows.flatMap((r) => ("key" in r ? [r.key] : []))));
  const leftovers: Def[] = [...declaredKeys].filter((k) => !named.has(k) && !NO_ROW.has(k)).map((key) => ({ key }));

  const toRow = async (d: Def): Promise<Row | null> => {
    if ("nav" in d) {
      const e = nav.get(d.nav);
      if (!e || !(await may(e))) return null;
      const id = d.nav.replace(/\./g, "_");
      return { id, href: e.href, title: soft(e.labelKey), description: text(`platform.settings.overview.desc.${id}`, "") };
    }
    if ("key" in d) {
      if (!canSettings || !declaredKeys.has(d.key)) return null;
      const s = declared.find((x) => x.key === d.key);
      return {
        id: d.key,
        href: d.href ?? `/admin/settings/${d.key}`,
        title: text(`platform.settings.overview.title.${d.key}`, d.key.replace(/_/g, " ")),
        description: text(`platform.settings.overview.desc.${d.key}`, s?.description ?? ""),
      };
    }
    if (!hasPermission(actor, d.permission)) return null;
    return { id: d.id, href: d.href, title: t(`overview.title.${d.id}`), description: t(`overview.desc.${d.id}`) };
  };

  const groups = (
    await Promise.all(
      GROUPS.map(async (g) => {
        const rows = (await Promise.all([...g.rows, ...(g.key === "technical" ? leftovers : [])].map(toRow))).filter((r): r is Row => !!r);
        return { key: g.key, rows: rows.filter((r, i) => rows.findIndex((o) => o.href === r.href) === i) };
      }),
    )
  ).filter((g) => g.rows.length > 0);

  return (
    <div className="grid gap-4">
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="grid items-start gap-4 lg:grid-cols-2" data-testid="settings-overview">
        {groups.map((g) => (
          <Surface key={g.key} flush aria-labelledby={`settings-${g.key}`} data-group={g.key}>
            <h2 id={`settings-${g.key}`} className="border-b border-border bg-[#faf9f6] px-5 py-2.5 text-[0.8125rem] font-semibold">
              {t(`overview.group.${g.key}`)}
            </h2>
            <ul>
              {g.rows.map((r) => (
                <li key={r.id} className="border-b border-border last:border-b-0">
                  <Link href={r.href as Route} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-[#faf9f6]" data-setting={r.id}>
                    <span className="grid min-w-0 leading-tight">
                      <span className="text-[0.8125rem] font-semibold first-letter:uppercase">{r.title}</span>
                      {r.description ? <span className="truncate text-[0.75rem] text-muted-foreground">{r.description}</span> : null}
                    </span>
                    <span aria-hidden="true" className="text-muted-foreground">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Surface>
        ))}
      </div>
    </div>
  );
}

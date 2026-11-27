import Link from "next/link";
import type { Actor } from "@/lib/ctx";
import { hasPermission } from "@/lib/auth";
import { PageHeader, PrimaryAction, Segmented } from "@/modules/platform/ui/admin-kit";
import { Disclosure } from "@/modules/platform/ui/admin-list-kit";

export type PrivacyTab = "requests" | "retention" | "dpia";
type StaffActor = Extract<Actor, { kind: "staff" }>;

/**
 * The one header of "Privacy & gegevens" (owner review, November 2026): the requests, the
 * retention policies (`privacy.run`) and the DPIA register (`settings.write`) as tabs of one page,
 * with "New request" on the requests tab and the person imports (`persons.write`) and data exports
 * (`persons.export`) behind "More".
 */
export function PrivacyHeader({ active, actor, tr }: { active: PrivacyTab; actor: StaffActor; tr: (key: string) => string }) {
  const canCreate = hasPermission(actor, "persons.erase") || hasPermission(actor, "persons.export") || hasPermission(actor, "persons.write");
  const tabs: { key: PrivacyTab; href: "/admin/privacy" | "/admin/privacy/retention" | "/admin/privacy/dpia"; label: string; show: boolean }[] = [
    { key: "requests", href: "/admin/privacy", label: tr("ops.privacy.tab_requests"), show: true },
    { key: "retention", href: "/admin/privacy/retention", label: tr("ops.nav.retention_policies"), show: hasPermission(actor, "privacy.run") },
    { key: "dpia", href: "/admin/privacy/dpia", label: tr("ops.nav.dpia"), show: hasPermission(actor, "settings.write") },
  ];
  const more: { key: string; href: "/admin/imports" | "/admin/reports/exports"; label: string }[] = [
    ...(hasPermission(actor, "persons.write") ? [{ key: "imports", href: "/admin/imports" as const, label: tr("ops.nav.imports") }] : []),
    ...(hasPermission(actor, "persons.export") ? [{ key: "exports", href: "/admin/reports/exports" as const, label: tr("ops.nav.exports") }] : []),
  ];
  return (
    <>
      <PageHeader
        title={tr("platform.nav.privacy")}
        description={tr("ops.privacy.subtitle")}
        actions={
          <>
            {more.length ? (
              <Disclosure label={tr("ops.privacy.more")} align="right">
                <ul className="grid gap-0.5 text-[0.8125rem]">
                  {more.map((m) => (
                    <li key={m.key}>
                      <Link href={m.href} className="block rounded-md px-2 py-1.5 font-medium hover:bg-muted">
                        {m.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
            {active === "requests" && canCreate ? (
              <PrimaryAction href="/admin/privacy/new">+ {tr("ops.privacy.new")}</PrimaryAction>
            ) : null}
          </>
        }
      />
      <Segmented label={tr("platform.nav.privacy")} items={tabs.filter((t) => t.show).map((t) => ({ key: t.key, label: t.label, href: t.href, active: t.key === active }))} />
    </>
  );
}

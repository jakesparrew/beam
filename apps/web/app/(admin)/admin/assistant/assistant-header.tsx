import type { ReactNode } from "react";
import { PageHeader, Segmented } from "@/modules/platform/ui/admin-kit";

export type AssistantTab = "overview" | "conversations" | "eval" | "settings";

/**
 * The one header of the AI assistant (owner review, November 2026): its four screens read as tabs
 * of one page, Overzicht | Gesprekken | Evaluatie | Instellingen; the last two need
 * `assistant.manage`. `aside` is the page's own status or action at the right.
 */
export function AssistantHeader({ active, canManage, tr, aside }: { active: AssistantTab; canManage: boolean; tr: (key: string) => string; aside?: ReactNode }) {
  const tabs: { key: AssistantTab; href: "/admin/assistant" | "/admin/assistant/conversations" | "/admin/assistant/eval" | "/admin/assistant/settings" }[] = [
    { key: "overview", href: "/admin/assistant" },
    { key: "conversations", href: "/admin/assistant/conversations" },
    ...(canManage
      ? [
          { key: "eval" as const, href: "/admin/assistant/eval" as const },
          { key: "settings" as const, href: "/admin/assistant/settings" as const },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader title={tr("assistant.admin.overview.title")} description={tr("assistant.admin.overview.subtitle")} actions={aside} />
      <Segmented label={tr("assistant.admin.overview.title")} items={tabs.map((t) => ({ key: t.key, label: tr(`assistant.nav.${t.key}`), href: t.href, active: t.key === active }))} />
    </>
  );
}

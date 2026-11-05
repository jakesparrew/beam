/**
 * crm navigation (crm spec 5.1 and 5.2; PL-19: an entry renders only when the user holds its
 * permission). Facade read by `pnpm gen:indexes`. The screens are built by crm-P2 (persons),
 * crm-P3 (portal pages), crm-P5 (segments), crm-P6 (tasks, companies), crm-P8 (pipeline) and
 * crm-P9 (inbox). The R3 entries carry `flag`: the shell shows them only while that flag is on.
 * Badges (spec 5.1, the shell's `badge` contract): "Tasks" shows the user's own overdue tasks,
 * "Inbox" the open threads nobody is assigned to (crm-P10). R4 "Knowledge" (crm-P10) lists the
 * BEAM policies AI reply drafts use.
 */
import type { Actor, DbOrTx } from "@/lib/ctx";
import { countOpenUnassignedThreads } from "./inbox/queries";
import { getTaskCounts } from "./tasks/queries";

async function ownOverdueTasks({ db, actor }: { db: DbOrTx; actor: Actor }): Promise<number> {
  if (actor.kind !== "staff") return 0;
  return (await getTaskCounts(db, actor.userId)).overdue;
}

async function openUnassignedThreads({ db }: { db: DbOrTx }): Promise<number> {
  return countOpenUnassignedThreads(db);
}

export const nav = [
  {
    key: "crm.persons",
    area: "admin",
    section: "customers",
    labelKey: "crm.nav.persons",
    href: "/admin/persons",
    permission: "persons.read",
    icon: "users",
    order: 200,
  },
  {
    key: "crm.segments",
    area: "admin",
    section: "customers",
    labelKey: "crm.nav.segments",
    href: "/admin/segments",
    permission: "persons.read",
    icon: "layers",
    order: 210,
  },
  {
    key: "crm.tasks",
    area: "admin",
    section: "customers",
    labelKey: "crm.nav.tasks",
    href: "/admin/tasks",
    permission: "persons.read",
    icon: "clipboard-list",
    order: 220,
    badge: ownOverdueTasks,
  },
  {
    key: "crm.companies",
    area: "admin",
    section: "customers",
    labelKey: "crm.nav.companies",
    href: "/admin/companies",
    permission: "persons.read",
    icon: "building",
    order: 230,
  },
  {
    key: "crm.pipeline",
    area: "admin",
    section: "customers",
    labelKey: "crm.nav.pipeline",
    href: "/admin/pipeline",
    permission: "crm.b2b",
    flag: "ff_crm_pipeline",
    icon: "briefcase",
    order: 240,
  },
  {
    key: "crm.inbox",
    area: "admin",
    section: "customers",
    labelKey: "crm.nav.inbox",
    href: "/admin/inbox",
    permission: "persons.read",
    flag: "ff_crm_inbox",
    icon: "inbox",
    order: 250,
    badge: openUnassignedThreads,
  },
  {
    key: "crm.inbox_knowledge",
    area: "admin",
    section: "customers",
    labelKey: "crm.nav.knowledge",
    href: "/admin/inbox/knowledge",
    permission: "persons.read",
    flag: "ff_crm_inbox",
    icon: "book-open",
    order: 255,
  },
  {
    key: "crm.profile",
    area: "portal",
    section: "account",
    labelKey: "crm.nav.profile",
    href: "/account/profile",
    icon: "user",
    order: 20,
  },
  {
    key: "crm.preferences",
    area: "portal",
    section: "account",
    labelKey: "crm.nav.preferences",
    href: "/account/preferences",
    icon: "mail",
    order: 30,
  },
] as const;

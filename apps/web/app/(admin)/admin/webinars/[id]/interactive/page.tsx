import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { adminErrorLabels, getWebinar, localizedLabels } from "@/modules/webinar/queries";
import { textIn } from "@/modules/webinar/server/lifecycle";
import { CtaEditor } from "@/modules/webinar/ui/admin/cta-editor";
import { PollEditor } from "@/modules/webinar/ui/admin/poll-editor";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/webinars/[id]/interactive` (`webinars.host`, webinar spec 5.1): polls and CTAs with
 * key, texts per page language, timing (mm:ss), tag rules and answer counts per mode; add, edit,
 * deactivate and reorder.
 */
export default async function WebinarInteractivePage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "webinars.host" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const detail = await getWebinar(await getAppDb(), id);
  if (!detail) notFound();
  const { webinar: w } = detail;
  const editable = w.status !== "cancelled" && w.status !== "archived";
  const errors = adminErrorLabels(tr);
  const g = (k: string) => tr(`webinar.admin.interactive.${k}`);
  const common = {
    edit: g("edit"),
    key: g("key"),
    keyHint: g("key_hint"),
    showAt: g("show_at"),
    showAtHint: g("show_at_hint"),
    showFor: g("show_for"),
    sortOrder: g("sort_order"),
    active: g("active"),
    inactive: g("inactive"),
    delete: g("delete"),
    deleted: g("deleted"),
    deactivated: g("deactivated"),
    save: g("save"),
    saved: g("saved"),
    close: g("cancel"),
    errors,
  };

  return (
    <div className="grid gap-6">
      <Link href={`/admin/webinars/${w.id}` as Route} className="text-sm underline">
        {textIn(w.title, locale) || w.slug}
      </Link>
      <h1 className="text-2xl font-semibold">{g("title")}</h1>
      {detail.polls.length === 0 && detail.ctas.length === 0 ? <EmptyState title={g("empty")} /> : null}
      <PollEditor
        webinarId={w.id}
        locales={w.locales}
        editable={editable}
        polls={detail.polls.map((p) => ({
          id: p.id,
          key: p.key,
          question: p.question,
          options: p.options,
          allowMultiple: p.allowMultiple,
          showAtSec: p.showAtSec,
          showForSec: p.showForSec,
          tagRules: p.tagRules,
          sortOrder: p.sortOrder,
          isActive: p.isActive,
          answers: p.answers,
        }))}
        labels={{
          ...common,
          polls: g("polls"),
          addPoll: g("add_poll"),
          question: localizedLabels(tr, g("question")),
          options: g("options"),
          optionKey: g("option_key"),
          optionLabel: localizedLabels(tr, g("option_label")),
          addOption: g("add_option"),
          removeOption: g("remove_option"),
          allowMultiple: g("allow_multiple"),
          tagRules: g("tag_rules"),
          tagRuleOptions: g("tag_rule_options"),
          tagRuleTag: g("tag_rule_tag"),
          tagRuleModes: g("tag_rule_modes"),
          addTagRule: g("add_tag_rule"),
          removeTagRule: g("remove_tag_rule"),
          answers: tr("webinar.admin.interactive.answers", { live: "{live}", replay: "{replay}", on_demand: "{on_demand}" }),
          watchModes: { live: tr("webinar.enum.watch_mode.live"), replay: tr("webinar.enum.watch_mode.replay"), on_demand: tr("webinar.enum.watch_mode.on_demand") },
          describeField: { tagRules: tr("webinar.admin.fields.tagRules") },
        }}
      />
      <CtaEditor
        webinarId={w.id}
        locales={w.locales}
        editable={editable}
        ctas={detail.ctas.map((c) => ({
          id: c.id,
          key: c.key,
          label: c.label,
          url: c.url,
          showAtSec: c.showAtSec,
          showForSec: c.showForSec,
          sortOrder: c.sortOrder,
          isActive: c.isActive,
          shown: c.shown,
          clicked: c.clicked,
        }))}
        labels={{
          ...common,
          ctas: g("ctas"),
          addCta: g("add_cta"),
          label: localizedLabels(tr, g("label")),
          url: g("url"),
          counts: tr("webinar.admin.interactive.cta_counts", { shown: "{shown}", clicked: "{clicked}" }),
        }}
      />
    </div>
  );
}

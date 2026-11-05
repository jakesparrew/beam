import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, Button, Input, Label, Tabs, TabsContent, TabsList, TabsTrigger } from "@beam/ui";
import { MARKETING_PURPOSES, type MarketingPurpose } from "@beam/core/email";
import type { Locale } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { listPublicEvents } from "@/modules/booking/api";
import { getSegmentSummaries } from "@/modules/crm/api";
import { createCampaign } from "@/modules/email/actions";
import { catalogueSection, listAiDrafts, listTemplates } from "@/modules/email/queries";
import { AiDraftPanel, type AiDraftPanelDraft } from "@/modules/email/ui/campaign/AiDraftPanel";

function field(form: FormData, name: string, fallback = ""): string {
  const v = form.get(name);
  return typeof v === "string" ? v : fallback;
}

async function create(form: FormData) {
  "use server";
  const purpose = field(form, "purpose", "newsletter") as MarketingPurpose;
  const templateId = field(form, "templateId");
  const result = await createCampaign({ name: field(form, "name"), purpose, ...(templateId ? { templateId } : {}) });
  if (!result.ok) redirect(`/admin/campaigns/new?error=${encodeURIComponent(result.error.message)}` as never);
  redirect(`/admin/campaigns/${result.data.campaignId}?step=content` as never);
}

/** Upcoming events for the AI tab: title in the admin locale (else any locale) and start date. */
function sessionLabel(s: { title: Partial<Record<Locale, string>>; startsAt: Date }, locale: Locale): string {
  const title = s.title[locale] || s.title["nl-BE"] || s.title["fr-BE"] || s.title.en || "";
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" }).format(s.startsAt);
  return `${title} (${when})`;
}

/**
 * `/admin/campaigns/new` (`email.write`), email spec section 5: name, purpose, and a blank
 * template (`campaign-<yyyymmdd>-<slug>`, created with the campaign) or an existing published
 * marketing template of the same purpose. R4 (email-P10): the "Draft with AI" tab (`ai.use` as
 * well) with the brief, up to three upcoming events, a segment hint and the staff member's newest
 * AI drafts (`AiDraftPanel`); `?tab=ai` opens it.
 */
export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ error?: string; tab?: string }> }) {
  const actor = await requireStaff({ permission: "email.write" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`email.campaigns.${k}`);
  const soft = softTranslator(locale);
  const db = await getAppDb();
  const templates = (await listTemplates(db, { kind: "marketing", status: "published" })).items;
  const errorKey = sp.error ? `email.campaigns.errors.${sp.error.replace(/[^a-z_]/g, "")}` : null;
  const errorText = errorKey ? (soft(errorKey) === errorKey ? t("errors.generic") : soft(errorKey)) : null;

  const canUseAi = hasPermission(actor, "ai.use");
  let ai: { drafts: AiDraftPanelDraft[]; sessions: { id: string; label: string }[]; segments: { id: string; name: string }[]; labels: Record<string, string> } | null = null;
  if (canUseAi) {
    const [drafts, events, segments] = await Promise.all([
      listAiDrafts(db, { createdByUserId: actor.userId, limit: 20 }),
      listPublicEvents(db, { from: new Date(), limit: 30, offset: 0 }),
      getSegmentSummaries(db),
    ]);
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(catalogueSection(locale, "email.ai"))) labels[`ai.${k}`] = v;
    for (const p of MARKETING_PURPOSES) labels[`campaigns.purpose_${p}`] = t(`purpose_${p}`);
    ai = {
      drafts: drafts.filter((d) => d.status !== "discarded"),
      sessions: events.map((e) => ({ id: e.sessionId, label: sessionLabel(e, locale) })),
      segments: segments.map((s) => ({ id: s.id, name: s.name })),
      labels,
    };
  }

  const manual = (
    <form action={create} className="grid gap-4 rounded-md border p-4" data-testid="campaign-new-form">
      <div className="grid gap-1">
        <Label htmlFor="campaign-name">{t("new_name")}</Label>
        <Input id="campaign-name" name="name" required maxLength={160} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="campaign-purpose">{t("new_purpose")}</Label>
        <select id="campaign-purpose" name="purpose" defaultValue="newsletter" className="h-9 rounded-md border bg-background px-2 text-sm">
          {MARKETING_PURPOSES.map((p) => (
            <option key={p} value={p}>
              {t(`purpose_${p}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="campaign-template">{t("new_source")}</Label>
        <select id="campaign-template" name="templateId" defaultValue="" className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">{t("source_blank")}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id} data-purpose={tpl.purpose ?? ""}>
              {`${t("source_template")}: ${tpl.name}${tpl.purpose ? ` (${t(`purpose_${tpl.purpose}`)})` : ""}`}
            </option>
          ))}
        </select>
        {templates.length === 0 ? <p className="text-sm text-muted-foreground">{t("new_template_none")}</p> : null}
      </div>
      <div>
        <Button type="submit" data-testid="campaign-create">
          {t("create")}
        </Button>
      </div>
    </form>
  );

  return (
    <div className="grid max-w-2xl gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("new_title")}</h1>
        <Button variant="ghost" asChild>
          <Link href="/admin/campaigns">{t("title")}</Link>
        </Button>
      </div>
      {errorText ? (
        <Alert variant="destructive">
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      ) : null}
      {ai ? (
        <Tabs defaultValue={sp.tab === "ai" ? "ai" : "manual"}>
          <TabsList>
            <TabsTrigger value="manual">{tr("email.ai.tab_manual")}</TabsTrigger>
            <TabsTrigger value="ai" data-testid="campaign-new-ai-tab">
              {tr("email.ai.tab_ai")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="manual">{manual}</TabsContent>
          <TabsContent value="ai">
            <AiDraftPanel purposes={MARKETING_PURPOSES} sessions={ai.sessions} segments={ai.segments} drafts={ai.drafts} labels={ai.labels} locale={locale} />
          </TabsContent>
        </Tabs>
      ) : (
        manual
      )}
    </div>
  );
}

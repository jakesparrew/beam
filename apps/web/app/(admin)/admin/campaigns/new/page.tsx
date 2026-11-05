import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, Button, Input, Label } from "@beam/ui";
import { MARKETING_PURPOSES, type MarketingPurpose } from "@beam/core/email";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { createCampaign } from "@/modules/email/actions";
import { listTemplates } from "@/modules/email/queries";

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

/**
 * `/admin/campaigns/new` (`email.write`), email spec section 5: name, purpose, and a blank
 * template (`campaign-<yyyymmdd>-<slug>`, created with the campaign) or an existing published
 * marketing template of the same purpose. The R4 "Draft with AI" tab comes with email-P10.
 */
export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireStaff({ permission: "email.write" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`email.campaigns.${k}`);
  const soft = softTranslator(locale);
  const templates = (await listTemplates(await getAppDb(), { kind: "marketing", status: "published" })).items;
  const errorKey = sp.error ? `email.campaigns.errors.${sp.error.replace(/[^a-z_]/g, "")}` : null;
  const errorText = errorKey ? (soft(errorKey) === errorKey ? t("errors.generic") : soft(errorKey)) : null;

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
    </div>
  );
}

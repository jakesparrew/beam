import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { URL_SEGMENT, localeFromSegment } from "@beam/core/i18n";
import { Button, FormField, Input } from "@beam/ui";
import { titleIn } from "@beam/email/templates/webinar";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { requestAccessLink } from "@/modules/webinar/actions";
import { getWebinarBySlug } from "@/modules/webinar/queries";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; slug: string }>; searchParams: Promise<{ sent?: string; error?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  return locale ? { title: translator(locale)("webinar.public.join.title"), robots: { index: false } } : {};
}

/**
 * `/[locale]/webinars/[slug]/join` (webinar spec 5.3): the lost-link page. The visitor enters an
 * email; when a registration of that address exists, the access email is sent again (throttled,
 * rule 14). The answer is the same either way (no enumeration). Rate limited like registration
 * (20 per IP per minute). A plain form posting a server action, so it works without JavaScript.
 */
export default async function JoinPage({ params, searchParams }: Props) {
  const { locale: seg, slug } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  if (!(await flag("ff_webinar_portal", { kind: "public" }))) notFound();
  const found = await getWebinarBySlug(await getAppDb(), slug, locale);
  if (!found || found.state === "cancelled") notFound();
  const tr = translator(locale);
  const { sent, error } = await searchParams;
  const here = `/${URL_SEGMENT[locale]}/webinars/${slug}/join`;

  async function send(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim();
    const website = String(formData.get("website") ?? "");
    const res = await requestAccessLink({ slug, email, locale, ...(website ? { website } : {}) });
    if (!res.ok) redirect(`${here}?error=${res.error.code === "validation" ? "invalid" : "internal"}` as Route);
    if (res.data.limited) redirect(`${here}?error=rate_limited` as Route);
    redirect(`${here}?sent=1` as Route);
  }

  const errorText = error === "rate_limited" ? tr("webinar.public.join.rate_limited") : error ? tr("webinar.public.join.invalid") : null;
  return (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{tr("webinar.public.join.title")}</h1>
        <p className="text-muted-foreground">{titleIn(found.webinar.title as Record<string, string>, locale)}</p>
        <p>{tr("webinar.public.join.intro")}</p>
      </header>
      <div aria-live="polite">
        {sent ? (
          <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            {tr("webinar.public.join.sent")}
          </p>
        ) : null}
        {errorText ? <p className="rounded-md border border-destructive p-3 text-sm">{errorText}</p> : null}
      </div>
      <form action={send} className="space-y-4">
        <FormField label={tr("webinar.public.join.email")} required>
          <Input name="email" type="email" autoComplete="email" required maxLength={254} />
        </FormField>
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label>
            Website
            <input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>
        <Button type="submit">{tr("webinar.public.join.submit")}</Button>
      </form>
      <p>
        <Link href={`/${URL_SEGMENT[locale]}/webinars/${slug}` as Route} className="underline underline-offset-2">
          {tr("webinar.public.join.back")}
        </Link>
      </p>
    </div>
  );
}

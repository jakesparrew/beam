import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { URL_SEGMENT, formatDateTime, localeFromSegment } from "@beam/core/i18n";
import { ERASE_CONFIRM_WORDS, RECTIFY_FIELDS, type PrivacyKind } from "@beam/core/ops";
import { Button, buttonVariants } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { cancelMyErasure, requestMyPrivacyAction } from "@/modules/ops/privacy/actions";
import { getMyPrivacyRequests } from "@/modules/ops/privacy/queries";

/**
 * `/[locale]/account/privacy` (ops spec 5, rules 59-61, 65-67): the customer's rights. Download
 * my data, delete my account (typed confirm word of the locale, the 24-hour cancel window and
 * what is retained), limit the use of my data, object to marketing, ask for a correction (field
 * names only), the status of their requests with the download and the erasure cancel, and a link
 * to the preference centre. Plain forms posting server actions, so the page works without
 * client JavaScript; every control has a visible label.
 */
type Op = PrivacyKind | "cancel";

export default async function AccountPrivacyPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ error?: string; done?: string }> }) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const sp = await searchParams;
  const requests = await getMyPrivacyRequests(await getAppDb(), actor.personId);
  const here = `/${URL_SEGMENT[locale]}/account/privacy`;
  const word = ERASE_CONFIRM_WORDS[locale];
  const now = Date.now();
  const openKinds = new Set(requests.filter((r) => r.status === "received" || r.status === "verified" || r.status === "running").map((r) => r.kind));
  const pendingErasure = requests.find((r) => r.kind === "erase" && r.status === "verified" && r.scheduledForAt && r.scheduledForAt.getTime() > now);

  async function act(fd: FormData) {
    "use server";
    const field = (k: string) => {
      const v = fd.get(k);
      return typeof v === "string" ? v : "";
    };
    const op = field("op") as Op;
    const res =
      op === "cancel"
        ? await cancelMyErasure({ requestId: field("requestId") })
        : await requestMyPrivacyAction({
            kind: op,
            ...(op === "erase" ? { confirmWord: field("confirmWord") } : {}),
            ...(op === "rectify" ? { rectifyFields: fd.getAll("rectifyFields").filter((v): v is string => typeof v === "string") } : {}),
          });
    if (res.ok) redirect(`${here}?done=${op}` as Route);
    const reason = res.error.code === "rate_limited" ? "rate_limited" : res.error.fields?.confirmWord ? "wrong_word" : res.error.code;
    redirect(`${here}?error=${encodeURIComponent(reason)}` as Route);
  }

  const errorText =
    sp.error === "rate_limited"
      ? tr("ops.privacy.portal.rate_limited")
      : sp.error === "wrong_word"
        ? tr("ops.privacy.portal.wrong_word")
        : sp.error
          ? tr(`platform.errors.${["forbidden", "validation", "not_found", "conflict", "unauthorized"].includes(sp.error) ? sp.error : "validation"}`)
          : null;

  const card = "grid gap-3 rounded-md border p-4";
  return (
    <section aria-labelledby="privacy-title" className="grid max-w-3xl gap-6">
      <div className="grid gap-2">
        <h1 id="privacy-title" className="text-2xl font-semibold">
          {tr("ops.privacy.portal.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{tr("ops.privacy.portal.intro")}</p>
      </div>
      {errorText ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm">
          {errorText}
        </p>
      ) : null}

      <div className={card}>
        <h2 className="text-lg font-semibold">{tr("ops.privacy.portal.export_title")}</h2>
        <p className="text-sm">{tr("ops.privacy.portal.export_body")}</p>
        <form action={act}>
          <input type="hidden" name="op" value="export" />
          <Button type="submit" disabled={openKinds.has("export")}>
            {tr("ops.privacy.portal.export_button")}
          </Button>
        </form>
      </div>

      <div className={card}>
        <h2 className="text-lg font-semibold">{tr("ops.privacy.portal.erase_title")}</h2>
        <p className="text-sm">{tr("ops.privacy.portal.erase_body")}</p>
        <p className="text-sm text-muted-foreground">{tr("ops.privacy.portal.erase_retained")}</p>
        {pendingErasure ? (
          <form action={act} className="grid gap-2">
            <p className="text-sm font-medium">{tr("ops.privacy.portal.erase_scheduled", { date: formatDateTime(pendingErasure.scheduledForAt!, locale) })}</p>
            <input type="hidden" name="op" value="cancel" />
            <input type="hidden" name="requestId" value={pendingErasure.id} />
            <Button type="submit" variant="outline" className="w-fit">
              {tr("ops.privacy.portal.cancel_erasure")}
            </Button>
          </form>
        ) : (
          <form action={act} className="grid gap-2">
            <input type="hidden" name="op" value="erase" />
            <label htmlFor="erase-confirm" className="text-sm font-medium">
              {tr("ops.privacy.portal.erase_confirm_label", { word })}
            </label>
            <input id="erase-confirm" name="confirmWord" required autoComplete="off" className="h-11 w-48 rounded-md border bg-background px-3" />
            <Button type="submit" variant="destructive" className="w-fit" disabled={openKinds.has("erase")}>
              {tr("ops.privacy.portal.erase_button")}
            </Button>
          </form>
        )}
      </div>

      <div className={card}>
        <h2 className="text-lg font-semibold">{tr("ops.privacy.portal.restrict_title")}</h2>
        <p className="text-sm">{tr("ops.privacy.portal.restrict_body")}</p>
        <form action={act}>
          <input type="hidden" name="op" value="restrict" />
          <Button type="submit" variant="outline">
            {tr("ops.privacy.portal.restrict_button")}
          </Button>
        </form>
      </div>

      <div className={card}>
        <h2 className="text-lg font-semibold">{tr("ops.privacy.portal.object_title")}</h2>
        <p className="text-sm">{tr("ops.privacy.portal.object_body")}</p>
        <form action={act}>
          <input type="hidden" name="op" value="object" />
          <Button type="submit" variant="outline">
            {tr("ops.privacy.portal.object_button")}
          </Button>
        </form>
        <Link href={`/${URL_SEGMENT[locale]}/account/preferences` as Route} className="text-sm underline underline-offset-4">
          {tr("ops.privacy.portal.preference_centre")}
        </Link>
      </div>

      <div className={card}>
        <h2 className="text-lg font-semibold">{tr("ops.privacy.portal.rectify_title")}</h2>
        <p className="text-sm">{tr("ops.privacy.portal.rectify_body")}</p>
        <form action={act} className="grid gap-2">
          <input type="hidden" name="op" value="rectify" />
          <fieldset className="grid gap-1 sm:grid-cols-2">
            <legend className="sr-only">{tr("ops.privacy.portal.rectify_title")}</legend>
            {RECTIFY_FIELDS.map((f) => (
              <label key={f} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="rectifyFields" value={f} />
                {tr(`ops.privacy.rectify_field.${f}`)}
              </label>
            ))}
          </fieldset>
          <Button type="submit" variant="outline" className="w-fit" disabled={openKinds.has("rectify")}>
            {tr("ops.privacy.portal.rectify_button")}
          </Button>
        </form>
      </div>

      <div className="grid gap-3">
        <h2 className="text-lg font-semibold">{tr("ops.privacy.portal.requests_title")}</h2>
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr("ops.privacy.portal.empty")}</p>
        ) : (
          <ul className="grid gap-2">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{tr(`ops.privacy.kind.${r.kind}`)}</span> · {tr(`ops.privacy.status.${r.status}`)} · {formatDateTime(r.createdAt, locale)}
                </span>
                {r.kind === "export" && r.status === "done" && r.hasExport ? (
                  <a href={`${here}/${r.id}/download`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    {tr("ops.privacy.portal.download")}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

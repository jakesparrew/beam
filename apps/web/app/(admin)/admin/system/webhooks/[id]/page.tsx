import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getWebhookEvent } from "@/modules/platform/queries";
import { ReplayWebhookButton } from "@/modules/platform/ui/system-tiles";

/** `/admin/system/webhooks/[id]` (`system.jobs`): one event with its payload (secret keys redacted), its job and its replays (PL-40). */
export default async function WebhookEventPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "system.jobs" });
  const { id } = await params;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.webhooks.${k}`, p);
  const event = await getWebhookEvent(await getAppDb(), id);
  if (!event) notFound();
  const when = (d: Date | null) => (d ? d.toLocaleString(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "medium" }) : "–");

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/system/webhooks" className="text-sm text-muted-foreground hover:underline">
          {t("back")}
        </Link>
        <h1 className="text-2xl font-semibold">
          {event.provider} · <span className="font-mono text-lg">{event.externalEventId}</span>
        </h1>
        <p className="text-sm text-muted-foreground">{t("received_at", { when: when(event.receivedAt) })}</p>
      </header>
      <section className="grid gap-2" aria-labelledby="job">
        <h2 id="job" className="text-lg font-medium">
          {t("job")}
        </h2>
        {event.job ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Link href={`/admin/system/jobs/${event.job.id}`} className="font-mono text-xs underline">
              {event.job.id}
            </Link>
            <Badge variant={event.job.status === "dead" ? "destructive" : "secondary"}>{tr(`platform.jobs.status_${event.job.status}`)}</Badge>
            <span>{t("attempts", { count: event.job.attempts })}</span>
            {event.job.lastError ? <span className="text-destructive">{event.job.lastError.split("\n")[0]}</span> : null}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("job_pruned")}</p>
        )}
        <ReplayWebhookButton webhookEventId={event.id} labels={catalogueSection(locale, "platform.webhooks")} errors={catalogueSection(locale, "platform.errors")} />
      </section>
      <section className="grid gap-2" aria-labelledby="replays">
        <h2 id="replays" className="text-lg font-medium">
          {t("replays")}
        </h2>
        {event.replays.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("no_replays")}</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {event.replays.map((r) => (
              <li key={r.id}>
                {when(r.createdAt)} · <span className="font-mono text-xs">{JSON.stringify(r.newValue)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid gap-2" aria-labelledby="payload">
        <h2 id="payload" className="text-lg font-medium">
          {t("payload")}
        </h2>
        <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(event.payload, null, 2)}</pre>
      </section>
    </div>
  );
}

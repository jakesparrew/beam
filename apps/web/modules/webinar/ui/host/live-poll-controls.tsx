"use client";
/**
 * Polls and CTAs of the host console (webinar spec 5.1, rule 34): Launch and Close a poll, Show
 * and Hide a CTA while the live webinar is live (launching one closes the poll on screen; the
 * launch position becomes `show_at_sec` for the replay), with the live results per option and
 * the replay and on-demand answers next to them, and the CTA shown and clicked counts. Every
 * control is a button with text; the state "on screen" is text, not only colour (rule 44).
 */
import Link from "next/link";
import type { Route } from "next";
import { Badge, Button } from "@beam/ui";
import { closePoll, hideCta, launchPoll, showCta } from "../../actions";

type Counts = { live: number; replay: number; on_demand: number };
type Run = (call: () => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>) => Promise<void>;

export type HostPollItem = {
  id: string;
  key: string;
  question: string;
  options: Array<{ key: string; label: string; counts: Counts }>;
  isActive: boolean;
  open: boolean;
  respondents: Counts;
};
export type HostCtaItem = { id: string; key: string; label: string; url: string; isActive: boolean; open: boolean; shown: Counts; clicked: Counts };

export type LivePollControlsLabels = {
  polls: string;
  ctas: string;
  noItems: string;
  interactiveLink: string;
  interactiveHref: string;
  launch: string;
  close: string;
  show: string;
  hide: string;
  onScreen: string;
  inactive: string;
  liveOnly: string;
  /** `{count}` live answers. */
  respondents: string;
  /** `{count}` replay and on-demand answers. */
  replayAnswers: string;
  /** `{shown}` and `{clicked}` (live). */
  ctaCounts: string;
};

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
const later = (c: Counts) => c.replay + c.on_demand;

export function LivePollControls(props: { polls: HostPollItem[]; ctas: HostCtaItem[]; live: boolean; pending: boolean; labels: LivePollControlsLabels; run: Run }) {
  const { polls, ctas, live, pending, labels, run } = props;
  const disabled = pending || !live;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="host-polls-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="host-polls-title" className="text-lg font-semibold">
          {labels.polls}
        </h2>
        <Link href={labels.interactiveHref as Route} className="text-sm underline underline-offset-2">
          {labels.interactiveLink}
        </Link>
      </div>
      {!live ? <p className="text-sm text-muted-foreground">{labels.liveOnly}</p> : null}
      {polls.length === 0 && ctas.length === 0 ? <p className="text-sm text-muted-foreground">{labels.noItems}</p> : null}
      <ul className="flex flex-col gap-3">
        {polls.map((p) => {
          const max = Math.max(1, ...p.options.map((o) => o.counts.live));
          return (
            <li key={p.id} className="rounded-lg border border-border p-3" data-testid="host-poll">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{p.question}</p>
                {p.open ? <Badge>{labels.onScreen}</Badge> : null}
                {!p.isActive ? <Badge variant="secondary">{labels.inactive}</Badge> : null}
              </div>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {p.options.map((o) => (
                  <li key={o.key} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2">
                    <span>{o.label}</span>
                    <span className="h-2 rounded bg-muted" aria-hidden="true">
                      <span className="block h-2 rounded bg-primary" style={{ width: `${Math.round((o.counts.live / max) * 100)}%` }} />
                    </span>
                    <span className="tabular-nums">{o.counts.live}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">
                {fill(labels.respondents, { count: p.respondents.live })} · {fill(labels.replayAnswers, { count: later(p.respondents) })}
              </p>
              <div className="mt-2 flex gap-2">
                {p.open ? (
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void run(() => closePoll({ pollId: p.id }))}>
                    {labels.close}
                  </Button>
                ) : (
                  <Button type="button" size="sm" disabled={disabled || !p.isActive} onClick={() => void run(() => launchPoll({ pollId: p.id }))}>
                    {labels.launch}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <h2 className="text-lg font-semibold">{labels.ctas}</h2>
      <ul className="flex flex-col gap-3">
        {ctas.map((c) => (
          <li key={c.id} className="rounded-lg border border-border p-3" data-testid="host-cta">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{c.label}</p>
              {c.open ? <Badge>{labels.onScreen}</Badge> : null}
              {!c.isActive ? <Badge variant="secondary">{labels.inactive}</Badge> : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">{c.url}</p>
            <p className="mt-1 text-xs text-muted-foreground">{fill(labels.ctaCounts, { shown: c.shown.live, clicked: c.clicked.live })}</p>
            <div className="mt-2 flex gap-2">
              {c.open ? (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void run(() => hideCta({ ctaId: c.id }))}>
                  {labels.hide}
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={disabled || !c.isActive} onClick={() => void run(() => showCta({ ctaId: c.id }))}>
                  {labels.show}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

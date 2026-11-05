/**
 * The step bar of `/admin/campaigns/[id]` (email spec section 5): Content, Audience, Review,
 * Schedule, then Sending once the campaign left `draft`. Each step is a link (`?step=`), marked
 * done when its check passes. No hooks, so server pages and client components can share it.
 */
import Link from "next/link";
import { cn } from "@beam/ui";

export type CampaignLabels = Readonly<Record<string, string>>;

/** A label with `{name}` parameters filled; the key itself when missing. */
export const clab = (labels: CampaignLabels, key: string, params: Record<string, string | number> = {}): string =>
  (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));

export const CAMPAIGN_STEPS = ["content", "audience", "review", "schedule", "progress"] as const;
export type CampaignStep = (typeof CAMPAIGN_STEPS)[number];

export function CampaignStepper(props: {
  campaignId: string;
  current: CampaignStep;
  steps: readonly { key: CampaignStep; done?: boolean }[];
  labels: CampaignLabels;
}) {
  return (
    <nav aria-label={clab(props.labels, "steps")} data-testid="campaign-stepper">
      <ol className="flex flex-wrap gap-2">
        {props.steps.map((s, i) => {
          const active = s.key === props.current;
          return (
            <li key={s.key}>
              <Link
                href={`/admin/campaigns/${props.campaignId}?step=${s.key}`}
                aria-current={active ? "step" : undefined}
                data-step={s.key}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm",
                  active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
              >
                <span className={cn("inline-flex size-5 items-center justify-center rounded-full border text-xs", s.done && !active ? "bg-muted" : "")} aria-hidden="true">
                  {s.done && !active ? "✓" : i + 1}
                </span>
                {clab(props.labels, `step_${s.key}`)}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

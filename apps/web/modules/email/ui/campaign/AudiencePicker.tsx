"use client";
/**
 * The Audience step (email spec section 5): the segment, the exclusion segments and the live
 * estimate (`estimateAudience`: total, reachable, per-locale counts and blocked reasons). The
 * estimate shows "counting..." and gives up after 10 s with "Estimate unavailable, try again".
 * Saving calls `updateCampaign` with the version the page read; a stale one shows the conflict.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Button, Checkbox, Label } from "@beam/ui";
import { BLOCKED_REASONS, type MarketingPurpose } from "@beam/core/email";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { estimateAudience, updateCampaign } from "../../actions";
import { clab, type CampaignLabels } from "./CampaignStepper";

type Estimate = { total: number; reachable: number; byLocale: Record<Locale, number>; blockedByReason: Partial<Record<string, number>> };

/** The estimate times out after this long (spec section 5). */
export const ESTIMATE_TIMEOUT_MS = 10_000;

export type AudiencePickerProps = {
  campaignId: string;
  version: number;
  purpose: MarketingPurpose;
  segments: readonly { id: string; name: string; lastCount: number | null }[];
  segmentId: string | null;
  excludeSegmentIds: readonly string[];
  editable: boolean;
  localeNames: Record<Locale, string>;
  labels: CampaignLabels;
};

export function AudiencePicker(props: AudiencePickerProps) {
  const { labels } = props;
  const router = useRouter();
  const [segmentId, setSegmentId] = useState(props.segmentId ?? "");
  const [excluded, setExcluded] = useState<string[]>([...props.excludeSegmentIds]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [counting, setCounting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const request = useRef(0);

  const count = useCallback(async () => {
    if (!segmentId) {
      setEstimate(null);
      return;
    }
    const id = ++request.current;
    setCounting(true);
    setUnavailable(false);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ESTIMATE_TIMEOUT_MS));
    const result = await Promise.race([estimateAudience({ segmentId, excludeSegmentIds: excluded.filter((e) => e !== segmentId), purpose: props.purpose }), timeout]);
    if (id !== request.current) return;
    setCounting(false);
    if (result && result.ok) setEstimate(result.data as Estimate);
    else setUnavailable(true);
  }, [segmentId, excluded, props.purpose]);

  useEffect(() => {
    void count();
  }, [count]);

  async function save() {
    setBusy(true);
    setMessage(null);
    const result = await updateCampaign({ campaignId: props.campaignId, expectedVersion: props.version, segmentId: segmentId || null, excludeSegmentIds: excluded.filter((e) => e !== segmentId) });
    setBusy(false);
    if (result.ok) {
      setMessage({ kind: "ok", text: clab(labels, "saved") });
      router.refresh();
    } else {
      const key = `errors.${result.error.code === "conflict" ? "conflict" : result.error.message}`;
      setMessage({ kind: "error", text: labels[key] ?? clab(labels, "errors.generic") });
    }
  }

  const others = props.segments.filter((s) => s.id !== segmentId);
  return (
    <section className="grid gap-4" data-testid="audience-picker">
      <div className="grid gap-1">
        <Label htmlFor="campaign-segment">{clab(labels, "segment")}</Label>
        <select
          id="campaign-segment"
          className="h-9 max-w-md rounded-md border bg-background px-2 text-sm"
          value={segmentId}
          disabled={!props.editable}
          onChange={(e) => setSegmentId(e.target.value)}
        >
          <option value="">{clab(labels, "segment_pick")}</option>
          {props.segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.lastCount === null ? s.name : `${s.name} (${s.lastCount})`}
            </option>
          ))}
        </select>
      </div>
      {others.length ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{clab(labels, "exclude")}</legend>
          {others.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={excluded.includes(s.id)}
                disabled={!props.editable}
                data-exclude-segment={s.id}
                onCheckedChange={(v) => setExcluded((xs) => (v === true ? [...new Set([...xs, s.id])] : xs.filter((x) => x !== s.id)))}
              />
              {s.name}
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="grid gap-2 rounded-md border p-4" aria-live="polite" data-testid="audience-estimate">
        <h3 className="font-medium">{clab(labels, "estimate_title")}</h3>
        {!segmentId ? (
          <p className="text-sm text-muted-foreground">{clab(labels, "segment_pick")}</p>
        ) : counting ? (
          <p className="text-sm text-muted-foreground">{clab(labels, "counting")}</p>
        ) : unavailable ? (
          <div className="flex items-center gap-2 text-sm">
            <span>{clab(labels, "estimate_unavailable")}</span>
            <Button size="sm" variant="outline" onClick={() => void count()}>
              {clab(labels, "retry")}
            </Button>
          </div>
        ) : estimate ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt>{clab(labels, "total")}</dt>
            <dd className="tabular-nums">{estimate.total}</dd>
            <dt>{clab(labels, "reachable")}</dt>
            <dd className="tabular-nums" data-testid="estimate-reachable">
              {estimate.reachable}
            </dd>
            <dt>{clab(labels, "by_locale")}</dt>
            <dd>{LOCALES.map((l) => `${props.localeNames[l]} ${estimate.byLocale[l] ?? 0}`).join(" · ")}</dd>
            <dt>{clab(labels, "blocked")}</dt>
            <dd>
              {BLOCKED_REASONS.filter((r) => estimate.blockedByReason[r])
                .map((r) => `${clab(labels, `blocked_${r}`)} ${estimate.blockedByReason[r]}`)
                .join(" · ") || "0"}
            </dd>
          </dl>
        ) : null}
      </div>

      {message ? (
        <Alert variant={message.kind === "error" ? "destructive" : "default"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      {props.editable ? (
        <div>
          <Button onClick={() => void save()} disabled={busy} data-testid="audience-save">
            {clab(labels, "save")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

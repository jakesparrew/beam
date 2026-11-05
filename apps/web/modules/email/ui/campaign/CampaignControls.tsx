"use client";
/**
 * The campaign controls (email spec rules 25, 29, 35 to 37): unschedule and refresh audience
 * (`scheduled`), pause (`sending`), resume (`paused`; after a bounce-rate pause the campaign name
 * must be typed), stop (`sending`, `paused`; the dialog says accepted messages cannot be
 * recalled), cancel (`draft`, `scheduled`) and duplicate. Buttons render only for staff with
 * `campaigns.send` (duplicate: `email.write`); the server refuses them otherwise too.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from "@beam/ui";
import type { CampaignStatus } from "@beam/core/email";
import { cancelCampaign, duplicateCampaign, pauseCampaign, refreshAudience, resumeCampaign, stopCampaign, unscheduleCampaign } from "../../actions";
import { clab, type CampaignLabels } from "./CampaignStepper";

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };
type Confirm = "stop" | "cancel" | "resume" | null;

export type CampaignControlsProps = {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  pausedReason: "manual" | "bounce_rate" | null;
  version: number;
  canSend: boolean;
  canWrite: boolean;
  labels: CampaignLabels;
};

export function CampaignControls(props: CampaignControlsProps) {
  const { labels, campaignId, version, status } = props;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [typed, setTyped] = useState("");

  async function run(call: () => Promise<Result>, onOk?: (data: unknown) => void) {
    setBusy(true);
    setNotice(null);
    const result = await call();
    setBusy(false);
    setConfirm(null);
    if (result.ok) {
      onOk?.(result.data);
      router.refresh();
    } else {
      const key = result.error.code === "conflict" ? "errors.conflict" : result.error.code === "forbidden" ? "errors.forbidden" : `errors.${result.error.message}`;
      setNotice({ kind: "error", text: labels[key] ?? clab(labels, "errors.generic") });
    }
  }

  const base = { campaignId, expectedVersion: version };
  const needsName = props.pausedReason === "bounce_rate";
  const send = props.canSend;

  return (
    <div className="grid gap-2" data-testid="campaign-controls">
      <div className="flex flex-wrap gap-2">
        {send && status === "scheduled" ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void run(() => unscheduleCampaign(base))} data-testid="campaign-unschedule">
              {clab(labels, "unschedule")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              data-testid="campaign-refresh"
              onClick={() =>
                void run(
                  () => refreshAudience(base),
                  (d) => {
                    const { added, skipped } = d as { added: number; skipped: number };
                    setNotice({ kind: "ok", text: clab(labels, "refreshed", { added, skipped }) });
                  },
                )
              }
            >
              {clab(labels, "refresh")}
            </Button>
          </>
        ) : null}
        {send && status === "sending" ? (
          <Button variant="outline" disabled={busy} onClick={() => void run(() => pauseCampaign(base))} data-testid="campaign-pause">
            {clab(labels, "pause")}
          </Button>
        ) : null}
        {send && status === "paused" ? (
          <Button disabled={busy} onClick={() => (needsName ? setConfirm("resume") : void run(() => resumeCampaign(base)))} data-testid="campaign-resume">
            {clab(labels, "resume")}
          </Button>
        ) : null}
        {send && (status === "sending" || status === "paused") ? (
          <Button variant="destructive" disabled={busy} onClick={() => setConfirm("stop")} data-testid="campaign-stop">
            {clab(labels, "stop")}
          </Button>
        ) : null}
        {send && (status === "draft" || status === "scheduled") ? (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirm("cancel")} data-testid="campaign-cancel">
            {clab(labels, "cancel")}
          </Button>
        ) : null}
        {props.canWrite ? (
          <Button
            variant="ghost"
            disabled={busy}
            data-testid="campaign-duplicate"
            onClick={() => void run(() => duplicateCampaign({ campaignId }), (d) => router.push(`/admin/campaigns/${(d as { campaignId: string }).campaignId}`))}
          >
            {clab(labels, "duplicate")}
          </Button>
        ) : null}
      </div>
      {notice ? (
        <Alert variant={notice.kind === "error" ? "destructive" : "default"}>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}

      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm ? clab(labels, confirm === "resume" ? "resume" : confirm) : ""}</DialogTitle>
            <DialogDescription>
              {confirm === "stop" ? clab(labels, "stop_warning") : confirm === "cancel" ? clab(labels, "cancel_warning") : clab(labels, "resume_confirm_name")}
            </DialogDescription>
          </DialogHeader>
          {confirm === "resume" ? (
            <div className="grid gap-1">
              <Label htmlFor="campaign-confirm-name">{props.name}</Label>
              <Input id="campaign-confirm-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {clab(labels, "close")}
            </Button>
            <Button
              variant={confirm === "resume" ? "default" : "destructive"}
              disabled={busy || (confirm === "resume" && typed.trim() !== props.name.trim())}
              data-testid="campaign-confirm"
              onClick={() =>
                void run(() =>
                  confirm === "stop" ? stopCampaign(base) : confirm === "cancel" ? cancelCampaign(base) : resumeCampaign({ ...base, confirmName: typed }),
                )
              }
            >
              {clab(labels, "confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

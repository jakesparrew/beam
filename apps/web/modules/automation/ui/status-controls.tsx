"use client";
/**
 * Status controls of the automation overview (automation spec 5, A-5, A-5a): Activate, Pause,
 * Resume, Archive (type the slug to confirm) and Enrol segment (segment picker with member
 * count). Only the moves A-5 allows are offered; Activate and Resume are disabled with the reason
 * while the DPIA gate is closed or no version is published. Each button posts its server action,
 * shows the error in the catalogue's words and refreshes the page on success.
 */
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FormField,
  Input,
} from "@beam/ui";
import { activateAutomation, archiveAutomation, enrolSegment, pauseAutomation, resumeAutomation } from "../actions";
import { errorText, fill, type ActionResultLike, type Labels } from "./outcome-badge";

export type StatusControlsProps = {
  automationId: string;
  slug: string;
  status: "draft" | "active" | "paused" | "archived";
  hasVersion: boolean;
  /** The DPIA gate (A-5a): null when the automation has none. */
  dpia: { key: string; approved: boolean } | null;
  segments: { id: string; name: string; memberCount: number }[];
  labels: Labels;
};

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(call: () => Promise<ActionResultLike>, l: Labels, onOk?: (data: unknown) => void): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await call();
      if (!r.ok) {
        setError(errorText(r.error, l));
        return false;
      }
      onOk?.(r.data);
      router.refresh();
      return true;
    } catch {
      setError(l["errors.generic"] ?? "");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function StatusControls(p: StatusControlsProps) {
  const l = p.labels;
  const { busy, error, run } = useAction();
  const gateClosed = !!p.dpia && !p.dpia.approved;
  const blockedReason = gateClosed ? fill(l["controls.activate_blocked_dpia"], { key: p.dpia!.key }) : !p.hasVersion ? l["controls.activate_blocked_unpublished"] : null;
  const reasonId = useId();
  if (p.status === "archived") return null;
  return (
    <div className="grid gap-2" data-testid="status-controls">
      <div className="flex flex-wrap gap-2">
        {p.status === "draft" ? (
          <Button
            disabled={busy || !!blockedReason}
            aria-describedby={blockedReason ? reasonId : undefined}
            onClick={() => void run(() => activateAutomation({ automationId: p.automationId }), l)}
            data-testid="automation-activate"
          >
            {l["controls.activate"]}
          </Button>
        ) : null}
        {p.status === "active" ? (
          <Button variant="outline" disabled={busy} onClick={() => void run(() => pauseAutomation({ automationId: p.automationId }), l)} data-testid="automation-pause">
            {l["controls.pause"]}
          </Button>
        ) : null}
        {p.status === "paused" ? (
          <Button
            disabled={busy || gateClosed}
            aria-describedby={gateClosed ? reasonId : undefined}
            onClick={() => void run(() => resumeAutomation({ automationId: p.automationId }), l)}
            data-testid="automation-resume"
          >
            {l["controls.resume"]}
          </Button>
        ) : null}
        {p.status === "active" ? <EnrolSegmentDialog {...p} /> : null}
        <ArchiveDialog {...p} />
      </div>
      {blockedReason && (p.status === "draft" || (p.status === "paused" && gateClosed)) ? (
        <p id={reasonId} className="text-sm text-muted-foreground">
          {blockedReason}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function ArchiveDialog(p: StatusControlsProps) {
  const l = p.labels;
  const [open, setOpen] = useState(false);
  const { busy, error, setError, run } = useAction();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const confirmSlug = String(new FormData(e.currentTarget).get("confirmSlug") ?? "");
    if (await run(() => archiveAutomation({ automationId: p.automationId, confirmSlug }), l)) setOpen(false);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" data-testid="automation-archive">
          {l["controls.archive"]}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{l["controls.archive_title"]}</DialogTitle>
            <DialogDescription>{l["controls.archive_body"]}</DialogDescription>
          </DialogHeader>
          <FormField label={fill(l["controls.archive_confirm"], { slug: p.slug })} required>
            <Input name="confirmSlug" autoComplete="off" />
          </FormField>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {l["common.cancel"]}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {l["controls.archive_submit"]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EnrolSegmentDialog(p: StatusControlsProps) {
  const l = p.labels;
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);
  const { busy, error, setError, run } = useAction();
  const selectId = useId();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const segmentId = String(new FormData(e.currentTarget).get("segmentId") ?? "");
    await run(() => enrolSegment({ automationId: p.automationId, segmentId }), l, (d) => setQueued((d as { estimatedCount: number }).estimatedCount));
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setError(null);
          setQueued(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="automation-enrol-segment">
          {l["controls.enrol_segment"]}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{l["controls.enrol_segment_title"]}</DialogTitle>
            <DialogDescription>{l["controls.enrol_segment_body"]}</DialogDescription>
          </DialogHeader>
          {p.segments.length === 0 ? (
            <p className="text-sm">{l["controls.no_segments"]}</p>
          ) : (
            <div className="grid gap-1">
              <label htmlFor={selectId} className="text-sm font-medium">
                {l["controls.segment"]}
              </label>
              <select id={selectId} name="segmentId" required className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {p.segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {fill(l["controls.segment_option"], { name: s.name, count: s.memberCount })}
                  </option>
                ))}
              </select>
            </div>
          )}
          {queued !== null ? (
            <Alert role="status">
              <AlertDescription>{fill(l["controls.enrol_queued"], { count: queued })}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {queued !== null ? l["controls.done"] : l["common.cancel"]}
            </Button>
            {queued === null ? (
              <Button type="submit" disabled={busy || p.segments.length === 0}>
                {l["controls.enrol_submit"]}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

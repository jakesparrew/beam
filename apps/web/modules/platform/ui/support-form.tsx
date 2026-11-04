"use client";
/**
 * Support forms (PL-86, PL-87): `AdminFrame` (the `AdminShell` with the "Report a problem"
 * dialog of the user menu, moved here from `login-form.tsx`), the same dialog behind a button
 * on `/admin/support`, and the form Sidestream uses on `/admin/system/support` to log a request
 * that arrived by email, Slack, WhatsApp or phone with its real received time.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AdminShell, Button, FormField, Input, ReportProblemDialog, Textarea, type AdminShellProps, type ReportProblemLabels } from "@beam/ui";
import { logSupportRequest, reportProblem } from "../actions";
import { ADMIN_SIGN_OUT_HREF, formValue } from "./login-form";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export function AdminFrame(props: Omit<AdminShellProps, "userMenu"> & { reportLabels: ReportProblemLabels; emergencyPhone: string }) {
  const { reportLabels, emergencyPhone, children, ...shell } = props;
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <AdminShell {...shell} userMenu={{ onReportProblem: () => setOpen(true), signOutHref: ADMIN_SIGN_OUT_HREF }}>
        {children}
      </AdminShell>
      <ReportProblemDialog
        open={open}
        onOpenChange={setOpen}
        labels={reportLabels}
        emergencyPhone={emergencyPhone}
        onSubmit={async (input) => {
          const result = await reportProblem({ ...input, pageUrl: input.pageUrl || window.location.pathname });
          if (result.ok) router.refresh();
          return result;
        }}
      />
    </>
  );
}

/** The "Report a problem" button of `/admin/support` (the same dialog as the user menu). */
export function ReportProblemButton({ label, reportLabels, emergencyPhone }: { label: string; reportLabels: ReportProblemLabels; emergencyPhone: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ReportProblemDialog
        open={open}
        onOpenChange={setOpen}
        labels={reportLabels}
        emergencyPhone={emergencyPhone}
        onSubmit={async (input) => {
          const result = await reportProblem({ ...input, pageUrl: input.pageUrl || window.location.pathname });
          if (result.ok) router.refresh();
          return result;
        }}
      />
    </>
  );
}

const SEVERITIES = ["critical", "high", "normal", "improvement"] as const;
const CHANNELS = ["email", "slack", "whatsapp", "phone"] as const;

/** Logs a request received outside the app (PL-87). */
export function LogSupportForm({ labels, errors, staff }: { labels: Labels; errors: Labels; staff: { id: string; name: string }[] }) {
  const r = useRun(errors);
  const [key, setKey] = useState(0);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const received = formValue(form, "receivedAt");
    const reporter = formValue(form, "reportedByUserId");
    const ok = await r.run(
      () =>
        logSupportRequest({
          title: formValue(form, "title"),
          description: formValue(form, "description"),
          severity: formValue(form, "severity"),
          channel: formValue(form, "channel"),
          receivedAt: received ? new Date(received).toISOString() : new Date().toISOString(),
          ...(reporter ? { reportedByUserId: reporter } : {}),
        }),
      lab(labels, "logged"),
    );
    if (ok) setKey((k) => k + 1);
  }
  return (
    <form key={key} onSubmit={(e) => void onSubmit(e)} className="grid max-w-2xl gap-3 rounded-md border p-4" noValidate>
      <h2 className="text-lg font-medium">{lab(labels, "log_title")}</h2>
      <FormField label={lab(labels, "col_title")}>
        <Input name="title" required minLength={3} maxLength={200} />
      </FormField>
      <FormField label={lab(labels, "description")}>
        <Textarea name="description" rows={3} />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lab(labels, "col_severity")}>
          <select name="severity" className="h-9 rounded-md border bg-background px-2 text-sm" defaultValue="normal">
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {lab(labels, `severity_${s}`)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={lab(labels, "col_channel")}>
          <select name="channel" className="h-9 rounded-md border bg-background px-2 text-sm" defaultValue="email">
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {lab(labels, `channel_${c}`)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={lab(labels, "received_at")}>
          <Input name="receivedAt" type="datetime-local" required />
        </FormField>
        <FormField label={lab(labels, "col_reporter")}>
          <select name="reportedByUserId" className="h-9 rounded-md border bg-background px-2 text-sm" defaultValue="">
            <option value="">{lab(labels, "nobody")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <Feedback ok={r.ok} error={r.error} />
      <div>
        <Button type="submit" disabled={r.pending}>
          {lab(labels, "log_submit")}
        </Button>
      </div>
    </form>
  );
}

"use client";

import { PhoneIcon } from "lucide-react";
import {
  useId,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import { Alert, AlertDescription } from "./components/alert";
import { Button } from "./components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/dialog";
import { Input } from "./components/input";
import { RadioGroup, RadioGroupItem } from "./components/radio-group";
import { Textarea } from "./components/textarea";
import { FormField } from "./form-field";

/** The four levels of proposal section 7 (`support_requests_severity`). */
const REPORT_SEVERITIES = [
  "critical",
  "high",
  "normal",
  "improvement",
] as const;
export type ReportProblemSeverity = (typeof REPORT_SEVERITIES)[number];

export type ReportProblemInput = {
  title: string;
  description: string;
  severity: ReportProblemSeverity;
  pageUrl: string;
};

/** Structurally compatible with `ActionResult<{ reference: string }>` of `lib/action.ts`. */
export type ReportProblemResult =
  | { ok: true; data: { reference: string } }
  | { ok: false; error: { message: string; fields?: Record<string, string> } };

export type ReportProblemLabels = {
  title: string;
  description: string;
  titleField: string;
  descriptionField: string;
  severityField: string;
  severities: Record<ReportProblemSeverity, { label: string; example: string }>;
  /** Shown for `critical`; `{phone}` is replaced by the emergency number as a tel: link. */
  emergency: string;
  /** Error when the title is not 3 to 200 characters. */
  titleLength: string;
  submit: string;
  submitting: string;
  cancel: string;
  /** Close button after success. */
  close: string;
  /** Success message; `{reference}` is replaced by the reference (for example SUP-2026-0001). */
  success: string;
};

export type ReportProblemDialogProps = {
  /** The app's `reportProblem` action (PL-86). */
  onSubmit: (input: ReportProblemInput) => Promise<ReportProblemResult>;
  labels: ReportProblemLabels;
  /** `settings.support.emergency_phone`, shown when the severity is critical. */
  emergencyPhone: string;
  /** Controlled open state (the AdminShell user menu opens it); uncontrolled with `trigger`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger element (for example the button on `/admin/support`). */
  trigger?: ReactNode;
  /** Page the problem was seen on; defaults to `window.location.href`. */
  pageUrl?: string;
};

function withPlaceholder(
  text: string,
  key: string,
  node: ReactNode,
): ReactNode {
  const [before, ...rest] = text.split(`{${key}}`);
  if (rest.length === 0) return text;
  return (
    <>
      {before}
      {node}
      {rest.join(`{${key}}`)}
    </>
  );
}

/** "Report a problem" (PL-86): title, description and severity; strings are props. */
export function ReportProblemDialog({
  onSubmit,
  labels,
  emergencyPhone,
  open,
  onOpenChange,
  trigger,
  pageUrl,
}: ReportProblemDialogProps) {
  const ids = useId().replace(/:/g, "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<ReportProblemSeverity>("normal");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setTitle("");
    setDescription("");
    setSeverity("normal");
    setErrors({});
    setFormError(null);
    setReference(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange?.(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length < 3 || trimmed.length > 200) {
      setErrors({ title: labels.titleLength });
      return;
    }
    setErrors({});
    setFormError(null);
    const url =
      pageUrl ?? (typeof window === "undefined" ? "" : window.location.href);
    startTransition(async () => {
      const result = await onSubmit({
        title: trimmed,
        description,
        severity,
        pageUrl: url,
      });
      if (result.ok) {
        setReference(result.data.reference);
      } else {
        setErrors(result.error.fields ?? {});
        setFormError(result.error.message);
      }
    });
  };

  const phoneLink = (
    <a
      href={`tel:${emergencyPhone.replace(/\s+/g, "")}`}
      className="font-semibold underline underline-offset-4"
    >
      {emergencyPhone}
    </a>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        {reference ? (
          <>
            <p role="status" className="text-sm">
              {withPlaceholder(
                labels.success,
                "reference",
                <strong className="font-mono">{reference}</strong>,
              )}
            </p>
            {severity === "critical" ? (
              <Alert variant="destructive">
                <PhoneIcon aria-hidden />
                <AlertDescription>
                  {withPlaceholder(labels.emergency, "phone", phoneLink)}
                </AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button>{labels.close}</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} noValidate className="grid gap-4">
            <FormField label={labels.titleField} error={errors.title} required>
              <Input
                name="title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={labels.descriptionField}
              error={errors.description}
            >
              <Textarea
                name="description"
                value={description}
                rows={4}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">
                {labels.severityField}
              </legend>
              <RadioGroup
                name="severity"
                value={severity}
                onValueChange={(v) => setSeverity(v as ReportProblemSeverity)}
              >
                {REPORT_SEVERITIES.map((s) => {
                  const id = `${ids}-severity-${s}`;
                  return (
                    <div key={s} className="flex items-start gap-3">
                      <RadioGroupItem
                        value={s}
                        id={id}
                        aria-describedby={`${id}-example`}
                        className="mt-0.5"
                      />
                      <div className="grid gap-0.5">
                        <label htmlFor={id} className="text-sm font-medium">
                          {labels.severities[s].label}
                        </label>
                        <span
                          id={`${id}-example`}
                          className="text-sm text-muted-foreground"
                        >
                          {labels.severities[s].example}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </RadioGroup>
            </fieldset>
            {severity === "critical" ? (
              <Alert variant="destructive" data-slot="emergency-phone">
                <PhoneIcon aria-hidden />
                <AlertDescription>
                  {withPlaceholder(labels.emergency, "phone", phoneLink)}
                </AlertDescription>
              </Alert>
            ) : null}
            {formError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {formError}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{labels.cancel}</Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending ? labels.submitting : labels.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

"use client";
/**
 * Test send dialog (email spec rule 60, action `sendTestEmail`): up to five staff addresses
 * (the server refuses any address that is not an active staff user's), one to three locales, the
 * draft or the current version, and the persona (Lead, Customer, Member with an optional
 * assessment outcome, or a real contact for staff with `persons.read`). The subject arrives with
 * a `[TEST]` prefix.
 */
import { useState } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beam/ui";
import { LOCALES, type Locale } from "@beam/core/i18n";
import type { SendTestEmailInput } from "@beam/core/email";
import { lab, type EditorLabels } from "./BlockCanvas";

type Result = { ok: true; data: { messageIds: string[] } } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

export type TestSendDialogProps = {
  templateId: string;
  campaignId?: string;
  defaultTo: string;
  hasDraft: boolean;
  hasCurrent: boolean;
  canReadPersons: boolean;
  localeNames: Record<Locale, string>;
  sendTestEmail: (input: SendTestEmailInput) => Promise<Result>;
  labels: EditorLabels;
  disabled?: boolean;
  /** Called after a successful send (the editor refreshes the review checklist). */
  onSent?: () => void;
};

export function TestSendDialog(props: TestSendDialogProps) {
  const { labels } = props;
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(props.defaultTo);
  const [locales, setLocales] = useState<Locale[]>(["nl-BE"]);
  const [use, setUse] = useState<"draft" | "current">(props.hasDraft ? "draft" : "current");
  const [persona, setPersona] = useState<"lead" | "customer" | "member" | "person">("lead");
  const [outcome, setOutcome] = useState("");
  const [personId, setPersonId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const addresses = to
    .split(/[,;\s]+/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const as = persona === "person" ? { personId: personId.trim() } : { sample: persona, ...(outcome.trim() ? { assessmentOutcome: outcome.trim() } : {}) };
      const result = await props.sendTestEmail({ templateId: props.templateId, use, locales, to: addresses, as, ...(props.campaignId ? { campaignId: props.campaignId } : {}) });
      if (result.ok) {
        setMessage({ ok: true, text: lab(labels, "test_sent", { count: result.data.messageIds.length }) });
        props.onSent?.();
      } else {
        const key = `error_${result.error.message}`;
        setMessage({ ok: false, text: labels[key] ? lab(labels, key) : lab(labels, "error_generic") });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={props.disabled || (!props.hasDraft && !props.hasCurrent)}>
          {lab(labels, "test_send")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{lab(labels, "test_send")}</DialogTitle>
          <DialogDescription>{lab(labels, "test_send_help")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="test-send-to">{lab(labels, "test_to")}</Label>
            <Input id="test-send-to" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <fieldset className="grid gap-1">
            <legend className="text-sm font-medium">{lab(labels, "test_locales")}</legend>
            <div className="flex flex-wrap gap-3">
              {LOCALES.map((l) => (
                <label key={l} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={locales.includes(l)} onCheckedChange={(v) => setLocales((cur) => (v ? [...new Set([...cur, l])] : cur.filter((x) => x !== l)))} />
                  {props.localeNames[l]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1">
            <Label>{lab(labels, "test_use")}</Label>
            <Select value={use} onValueChange={(v) => setUse(v as "draft" | "current")}>
              <SelectTrigger aria-label={lab(labels, "test_use")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {props.hasDraft ? <SelectItem value="draft">{lab(labels, "use_draft")}</SelectItem> : null}
                {props.hasCurrent ? <SelectItem value="current">{lab(labels, "use_current")}</SelectItem> : null}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>{lab(labels, "preview_as")}</Label>
            <Select value={persona} onValueChange={(v) => setPersona(v as typeof persona)}>
              <SelectTrigger aria-label={lab(labels, "preview_as")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lead">{lab(labels, "persona_lead")}</SelectItem>
                <SelectItem value="customer">{lab(labels, "persona_customer")}</SelectItem>
                <SelectItem value="member">{lab(labels, "persona_member")}</SelectItem>
                {props.canReadPersons ? <SelectItem value="person">{lab(labels, "persona_person")}</SelectItem> : null}
              </SelectContent>
            </Select>
          </div>
          {persona === "person" ? (
            <div className="grid gap-1">
              <Label htmlFor="test-send-person">{lab(labels, "person_id")}</Label>
              <Input id="test-send-person" value={personId} onChange={(e) => setPersonId(e.target.value)} />
            </div>
          ) : (
            <div className="grid gap-1">
              <Label htmlFor="test-send-outcome">{lab(labels, "assessment_outcome")}</Label>
              <Input id="test-send-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
            </div>
          )}
          {message ? (
            <Alert variant={message.ok ? "default" : "destructive"}>
              <AlertDescription>{message.text}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => void send()} disabled={busy || !addresses.length || addresses.length > 5 || !locales.length}>
            {lab(labels, "send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

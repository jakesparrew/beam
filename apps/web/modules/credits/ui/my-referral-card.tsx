"use client";
/**
 * The portal referral card (credits rule 60, `/[locale]/account/referrals`, R3): the reader's
 * personal code and share link `…/<locale>?ref=<CODE>`. Without a code yet, "Get my link" creates
 * it (`getOrCreateMyReferralCode`); "Copy link" puts the link on the clipboard and says so in a
 * live region. Every string arrives as a prop; touch targets are at least 44 px.
 */
import { useState } from "react";
import { Alert, AlertDescription, Button } from "@beam/ui";
import { getOrCreateMyReferralCode } from "../actions";

export type MyReferralCardLabels = {
  codeLabel: string;
  linkLabel: string;
  getLink: string;
  copy: string;
  copied: string;
  error: string;
};

export function MyReferralCard({ code: initialCode, shareUrl: initialUrl, labels: l }: { code: string | null; shareUrl: string | null; labels: MyReferralCardLabels }) {
  const [code, setCode] = useState(initialCode);
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    setError(false);
    try {
      const r = await getOrCreateMyReferralCode({});
      if (r.ok) {
        setCode(r.data.code);
        setUrl(r.data.shareUrl);
      } else setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError(true);
    }
  }

  return (
    <div className="grid gap-4 rounded-lg border p-4">
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{l.error}</AlertDescription>
        </Alert>
      ) : null}
      {code && url ? (
        <>
          <div className="grid gap-1">
            <p className="text-sm text-muted-foreground">{l.codeLabel}</p>
            <p className="font-mono text-2xl font-semibold tracking-widest" data-testid="referral-code">
              {code}
            </p>
          </div>
          <div className="grid gap-1">
            <label htmlFor="referral-link" className="text-sm text-muted-foreground">
              {l.linkLabel}
            </label>
            <input id="referral-link" readOnly value={url} className="min-h-11 w-full rounded-md border bg-muted px-3 text-sm" onFocus={(e) => e.currentTarget.select()} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" className="min-h-11" onClick={() => void copy()}>
              {l.copy}
            </Button>
            <span aria-live="polite" className="text-sm text-muted-foreground">
              {copied ? l.copied : ""}
            </span>
          </div>
        </>
      ) : (
        <Button type="button" className="min-h-11 w-fit" disabled={busy} onClick={() => void create()}>
          {l.getLink}
        </Button>
      )}
    </div>
  );
}

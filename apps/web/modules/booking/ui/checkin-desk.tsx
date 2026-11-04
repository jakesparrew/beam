"use client";
/**
 * The reception desk's scan field (booking spec 5.1 `/admin/bookings/checkin`, 5.4): one focused
 * input that accepts a scanned code (a USB or Bluetooth scanner types the code or the QR URL
 * and Enter), a typed code or a name. Submitting navigates to `?q=<input>`; the page then shows
 * the result card or the name matches (`children`). The input keeps focus after each scan and is
 * emptied, so the next guest can be scanned at once. Every text comes from the page.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input, Label } from "@beam/ui";

export type CheckinDeskLabels = { scan: string; submit: string; hint: string };

export function CheckinDesk({ labels, children }: { labels: CheckinDeskLabels; children?: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  // After every navigation (a scan, a check-in refresh) the field takes focus again.
  useEffect(() => {
    input.current?.focus();
  }, [params]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = value.trim();
    if (!q) return;
    setValue("");
    const next = new URLSearchParams();
    next.set("q", q);
    router.push(`${pathname}?${next.toString()}` as never);
  }

  return (
    <div className="grid gap-4">
      <form role="search" onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="grid gap-1">
          <Label htmlFor="checkin-scan" className="text-base">
            {labels.scan}
          </Label>
          <Input
            ref={input}
            id="checkin-scan"
            name="q"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-describedby="checkin-scan-hint"
            className="h-12 text-lg"
          />
          <p id="checkin-scan-hint" className="text-sm text-muted-foreground">
            {labels.hint}
          </p>
        </div>
        <Button type="submit" size="lg" className="min-h-11">
          {labels.submit}
        </Button>
      </form>
      <div aria-live="polite" className="grid gap-4">
        {children}
      </div>
    </div>
  );
}

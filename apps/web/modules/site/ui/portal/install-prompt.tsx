"use client";

/**
 * "Install the BEAM app" card on account home (site section 5, PWA; site-P6). It captures
 * `beforeinstallprompt` and shows the card from the second portal visit on; on iOS Safari, which
 * has no install event, it shows the "Share, then Add to Home Screen" instruction instead. It
 * never shows inside the installed app (`display-mode: standalone`). "Not now" is remembered in
 * `localStorage` for 90 days. Visits are counted once per browser session.
 */
import { useEffect, useState } from "react";
import { Button, Card, CardContent, CardHeader } from "@beam/ui";

export const VISITS_KEY = "beam_portal_visits";
export const DISMISSED_KEY = "beam_install_dismissed_at";
const SESSION_KEY = "beam_portal_visit_counted";
export const DISMISS_DAYS = 90;

export type InstallPromptLabels = { title: string; body: string; button: string; dismiss: string; ios: string };

type InstallEvent = Event & { prompt(): Promise<void>; userChoice?: Promise<{ outcome: string }> };

function storage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Counts this visit (once per browser session) and returns the number of portal visits. */
export function countVisit(local: Storage | null, session: Storage | null): number {
  const current = Number(local?.getItem(VISITS_KEY) ?? "0") || 0;
  if (session?.getItem(SESSION_KEY)) return current;
  const next = current + 1;
  local?.setItem(VISITS_KEY, String(next));
  session?.setItem(SESSION_KEY, "1");
  return next;
}

/** True while a "Not now" from the last 90 days is stored. */
export function isDismissed(local: Storage | null, now: number = Date.now()): boolean {
  const at = Number(local?.getItem(DISMISSED_KEY) ?? "0") || 0;
  return at > 0 && now - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

/** iPhone or iPad Safari (not Chrome, Firefox or Edge on iOS, which use the same engine). */
export function isIosSafari(userAgent: string, maxTouchPoints = 0): boolean {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
}

function isStandalone(): boolean {
  try {
    return window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function InstallPrompt({ labels }: { labels: InstallPromptLabels }) {
  const [mode, setMode] = useState<"hidden" | "prompt" | "ios">("hidden");
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    if (isStandalone()) return;
    const local = storage("local");
    const visits = countVisit(local, storage("session"));
    if (visits < 2 || isDismissed(local)) return;
    if (isIosSafari(navigator.userAgent, navigator.maxTouchPoints ?? 0)) {
      setMode("ios");
      return;
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallEvent);
      setMode("prompt");
    };
    const onInstalled = () => setMode("hidden");
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (mode === "hidden") return null;

  const dismiss = () => {
    try {
      storage("local")?.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // Storage full or blocked: the card simply comes back next visit.
    }
    setMode("hidden");
  };

  const install = async () => {
    if (!event) return;
    await event.prompt();
    await event.userChoice?.catch(() => undefined);
    setEvent(null);
    setMode("hidden");
  };

  return (
    <Card data-home-card="install" role="region" aria-labelledby="home-install-title">
      <CardHeader>
        <h2 id="home-install-title" className="text-lg font-semibold">
          {labels.title}
        </h2>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">{mode === "ios" ? labels.ios : labels.body}</p>
        <div className="flex flex-wrap gap-2">
          {mode === "prompt" ? (
            <Button type="button" size="sm" onClick={() => void install()}>
              {labels.button}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={dismiss}>
            {labels.dismiss}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

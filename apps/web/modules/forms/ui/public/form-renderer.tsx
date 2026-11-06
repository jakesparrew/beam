"use client";

/**
 * The public form renderer (forms spec section 5 "Public", rules U1 to U7, L5, ID2, ID10, R3):
 * one section per page, progress "Step n of total", prefill summary with "Not you?", the resume
 * offer, localised validation with an error summary that receives focus, and the ending.
 *
 * - `start` is called on the first interaction (first answer or the Next button), never on page
 *   view; the view beacon counts the page view.
 * - Each Next saves the section; the server's next step is authoritative (L5). A network error
 *   shows "Could not save, retrying" and retries after 1, 3 and 9 seconds, then a retry button.
 * - On a completed submit the ending is shown and `beam-form:completed` is emitted exactly once per
 *   submission with `{ slug, kind, locale, endingKind }` (no person data): inline as a window
 *   `CustomEvent`, inside the embed iframe as a `postMessage` to the parent origin. A dropped bot
 *   submit or a repeated submit (`completedNow: false`) emits nothing.
 * - `mode: 'embed'` posts its height to the parent (`beam-form:height`).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { computeScore, isVisible, nextStep, validateSection, type AnswerValue, type Answers, type EndingKind, type FormDefinition, type FormKind, type FormScoring, type ScoreState } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { Button } from "@beam/ui";
import { errorText, FieldInput, Markdown, type PublicLabels } from "./field-inputs";

export type PublicPrefill = { firstName: string | null; maskedEmail: string | null; known: string[] };

export type FormRendererProps = {
  slug: string;
  kind: FormKind;
  locale: Locale;
  definition: FormDefinition;
  scoring: FormScoring;
  labels: PublicLabels;
  /** `page` = hosted page, `embed` = inside the embed iframe, `inline` = `FormEmbed` on the BEAM site. */
  mode: "page" | "embed" | "inline";
  /** The query of the hosted page (hidden fields, `l`, `embedHost`, `ref`). */
  query?: Readonly<Record<string, string>>;
  embedContext?: string | null;
  identityToken?: string | null;
  prefill?: PublicPrefill | null;
  /** ID10: the guest's first name in staff-assisted entry (shows the staff banner). */
  staffFirstName?: string | null;
  /** Origin of the API (default: same origin). */
  apiBase?: string;
};

export type CompletedDetail = { slug: string; kind: FormKind; locale: Locale; endingKind: EndingKind };

type Ending = { key: string; resultUrl?: string; redirectUrl?: string; pendingConfirmation: boolean; guardianConsent: boolean };
type Status = "idle" | "saving" | "retrying" | "failed" | "rate_limited" | "closed";
type Reply = { status: number; data: Record<string, unknown> | null };

/** sessionStorage of site's UTM capture (rule 40): `{ utm, landingPath }` of the first landing of the visit. */
const SITE_UTM_KEY = "beam_utm";
const RETRY_DELAYS_MS = [1000, 3000, 9000];
const resumeKey = (slug: string) => `beam_form_${slug}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function storage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The landing URL sent to `start`: inline forms on later pages get the visit's stored UTM (site rule 40). */
function landingUrl(mode: FormRendererProps["mode"]): string {
  const url = new URL(window.location.href);
  if (mode !== "inline" || [...url.searchParams.keys()].some((k) => k.startsWith("utm_"))) return url.toString();
  try {
    const raw = storage("session")?.getItem(SITE_UTM_KEY);
    const stored = raw ? (JSON.parse(raw) as { utm?: Record<string, string> }) : null;
    for (const [k, v] of Object.entries(stored?.utm ?? {})) if (typeof v === "string" && v) url.searchParams.set(`utm_${k}`, v.slice(0, 200));
  } catch {
    // Unreadable storage: no stored attribution.
  }
  return url.toString();
}

const noSubscribe = () => () => undefined;

/** U5: the resume token this browser keeps for a form, or null. */
function storedResumeToken(slug: string): string | null {
  try {
    const raw = storage("local")?.getItem(resumeKey(slug));
    const token = raw ? (JSON.parse(raw) as { token?: unknown }).token : null;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

/** Values of `hidden` and `utm` fields (never rendered, F3). */
function hiddenValues(def: FormDefinition, query: Readonly<Record<string, string>>): Answers {
  const out: Answers = {};
  for (const f of Object.values(def.fields)) {
    if (f.type === "hidden") {
      const v = f.from === "constant" ? f.value : query[f.param ?? f.key];
      if (v) out[f.key] = v.slice(0, 100);
    } else if (f.type === "utm" && query[f.param]) out[f.key] = query[f.param]!.slice(0, 100);
  }
  return out;
}

export function FormRenderer(p: FormRendererProps) {
  const { definition: def, scoring, labels, locale, slug } = p;
  const query = useMemo(() => p.query ?? {}, [p.query]);
  const idPrefix = `bf${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const first = useMemo(() => {
    const s = nextStep(def, scoring, {}, null);
    return "section" in s ? s.section : (def.sections[0]?.key ?? "");
  }, [def, scoring]);
  const [sectionKey, setSectionKey] = useState(first);
  const [history, setHistory] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>("idle");
  const [ending, setEnding] = useState<Ending | null>(null);
  const [prefill, setPrefill] = useState<PublicPrefill | null>(p.prefill ?? null);
  const [identityToken, setIdentityToken] = useState<string | null>(p.identityToken ?? null);
  const [resumeDismissed, setResumeDismissed] = useState(false);
  const [started, setStarted] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const sub = useRef<{ id: string; resumeToken: string | null } | null>(null);
  const starting = useRef<Promise<boolean> | null>(null);
  /** Set when `start` resumed a submission at another section; the pending Next stops there. */
  const movedByResume = useRef(false);
  const emitted = useRef(new Set<string>());
  const summaryRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const api = (path: string) => `${p.apiBase ?? ""}/api/public/forms/${encodeURIComponent(slug)}/${path}`;
  const parentOrigin = useMemo(() => {
    if (p.mode !== "embed" || typeof document === "undefined") return null;
    try {
      if (document.referrer) return new URL(document.referrer).origin;
    } catch {
      /* fall through */
    }
    return query.embedHost ? `https://${query.embedHost}` : null;
  }, [p.mode, query.embedHost]);

  const call = useCallback(async (url: string, init?: { method?: string; body?: unknown }): Promise<Reply> => {
    const res = await fetch(url, {
      method: init?.method ?? "POST",
      credentials: "include",
      headers: init?.body === undefined ? {} : { "content-type": "application/json" },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    let data: Record<string, unknown> | null;
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }, []);

  // The page view (funnel), once.
  useEffect(() => {
    const linkKey = query.l && /^[a-z0-9]{1,16}$/.test(query.l) ? query.l : undefined;
    void call(api("view"), { body: { locale, ...(linkKey ? { linkKey } : {}) } }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // U5: offer to continue an earlier submission of this browser (read after hydration).
  const resumeEnabled = def.settings.resumeEnabled && p.mode !== "embed";
  const storedResume = useSyncExternalStore(noSubscribe, () => (resumeEnabled ? storedResumeToken(slug) : null), () => null);
  const resumeOffer = !resumeDismissed && !started ? storedResume : null;

  // `?embed=1`: the parent resizes the iframe on `beam-form:height`.
  useEffect(() => {
    if (p.mode !== "embed" || !rootRef.current || typeof ResizeObserver === "undefined" || !parentOrigin) return;
    const el = rootRef.current;
    const post = () => window.parent.postMessage({ type: "beam-form:height", h: Math.ceil(el.getBoundingClientRect().height) }, parentOrigin);
    const ro = new ResizeObserver(post);
    ro.observe(el);
    post();
    return () => ro.disconnect();
  }, [p.mode, parentOrigin]);

  // A failed check moves focus to the error summary (WCAG: errors announced and reachable).
  useEffect(() => {
    if (focusTick) summaryRef.current?.focus();
  }, [focusTick]);

  const scores = useMemo(() => computeScore(def, scoring, answers) as unknown as ScoreState, [def, scoring, answers]);
  const section = def.sections.find((s) => s.key === sectionKey) ?? def.sections[0]!;
  const known = new Set(prefill?.known ?? []);
  const visibleFields = section.fieldKeys
    .map((k) => def.fields[k])
    .filter((f): f is NonNullable<typeof f> => !!f && f.type !== "hidden" && f.type !== "utm" && !known.has(f.key) && isVisible(f, { answers, scores }));
  const willEnd = "end" in nextStep(def, scoring, answers, sectionKey);
  const step = history.length + 1;
  const total = Math.max(step, step + (willEnd ? 0 : 1));

  /**
   * U5: restores a continued submission's saved answers and moves to the section to continue at
   * (unknown or missing: the first). `keepLocal` keeps what this device already typed before the
   * session resume answered. Returns whether the visible section changed.
   */
  const restore = (saved: Answers, currentSectionKey: string | null, keepLocal: boolean): boolean => {
    setAnswers((a) => (keepLocal ? { ...saved, ...a } : { ...saved }));
    const order = def.sections.map((s) => s.key);
    const cur = currentSectionKey && order.includes(currentSectionKey) ? currentSectionKey : first;
    setHistory(order.slice(0, Math.max(0, order.indexOf(cur))));
    setSectionKey(cur);
    return cur !== sectionKey;
  };

  const failWith = (r: Reply): boolean => {
    const err = (r.data?.error ?? null) as { code?: string; fields?: Record<string, string> } | null;
    if (r.status === 410) setStatus("closed");
    else if (r.status === 429) setStatus("rate_limited");
    else if (r.status === 400 && err?.fields) {
      setErrors(err.fields);
      setStatus("idle");
      setFocusTick((t) => t + 1);
    } else setStatus("failed");
    return false;
  };

  const ensureStarted = useCallback(async (): Promise<boolean> => {
    if (sub.current) return true;
    starting.current ??= (async () => {
      const r = await call(api("start"), {
        body: {
          locale,
          url: landingUrl(p.mode),
          ...(query.ref || (typeof document !== "undefined" && document.referrer) ? { referrer: query.ref || document.referrer } : {}),
          ...(query.embedHost ? { embedHost: query.embedHost } : {}),
          ...(identityToken ? { identityToken } : {}),
          ...(p.embedContext ? { embedContext: p.embedContext } : {}),
          honeypot,
        },
      });
      const id = typeof r.data?.submissionId === "string" ? r.data.submissionId : null;
      if (r.status !== 200 || !id) {
        starting.current = null;
        return failWith(r);
      }
      const resumeToken = typeof r.data?.resumeToken === "string" ? r.data.resumeToken : null;
      sub.current = { id, resumeToken };
      setStarted(true);
      if (resumeToken && def.settings.resumeEnabled && p.mode !== "embed") {
        try {
          storage("local")?.setItem(resumeKey(slug), JSON.stringify({ token: resumeToken }));
        } catch {
          // Storage blocked: the resume token stays in memory (edge case 22).
        }
      }
      const pf = r.data?.prefill as PublicPrefill | undefined;
      if (pf && !prefill) setPrefill(pf);
      // U5 (R2): a logged-in customer continues their open submission from another device.
      const resumed = r.data?.resumed as { answers?: unknown; currentSectionKey?: unknown } | undefined;
      if (resumed && typeof resumed === "object") {
        const answersIn = resumed.answers && typeof resumed.answers === "object" ? (resumed.answers as Answers) : {};
        const cur = typeof resumed.currentSectionKey === "string" ? resumed.currentSectionKey : null;
        movedByResume.current = restore(answersIn, cur, true);
      }
      return true;
    })().catch(() => {
      starting.current = null;
      setStatus("failed");
      return false;
    });
    return starting.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, honeypot, identityToken, locale, p.embedContext, p.mode, prefill, query, slug]);

  const setAnswer = (key: string, v: AnswerValue | undefined) => {
    setAnswers((a) => {
      const next = { ...a };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return next;
    });
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
    void ensureStarted();
  };

  // Typed before hydration (a slow phone, the JavaScript still loading): React keeps the text a
  // visitor typed into a controlled field, but the answers start empty, so the form showed the
  // text and still answered "this field is required". Adopt what the fields hold, once.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const f of visibleFields) {
        if (answers[f.key] !== undefined) continue;
        const el = document.getElementById(`${idPrefix}-${f.key}`);
        if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
          if (el.value) setAnswer(f.key, el.value);
        } else if (el instanceof HTMLInputElement && el.type !== "checkbox" && el.type !== "radio" && el.value.trim() !== "") {
          setAnswer(f.key, el.type === "number" ? Number(el.value) : el.value);
        }
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A network error retries after 1, 3 and 9 seconds; HTTP errors answer at once. */
  const send = async (path: string, body: unknown): Promise<Reply | null> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(api(path), { body });
      } catch {
        if (attempt >= RETRY_DELAYS_MS.length) {
          setStatus("failed");
          return null;
        }
        setStatus("retrying");
        await sleep(RETRY_DELAYS_MS[attempt]!);
      }
    }
  };

  const proof = () => ({
    submissionId: sub.current!.id,
    ...(sub.current!.resumeToken ? { resumeToken: sub.current!.resumeToken } : {}),
    ...(identityToken ? { identityToken } : {}),
  });

  const submit = async () => {
    const r = await send("submit", { ...proof(), answers: { ...answers, ...hiddenValues(def, query) }, honeypot });
    if (!r) return;
    if (r.status !== 200) return void failWith(r);
    const d = r.data ?? {};
    const endingKey = typeof d.endingKey === "string" ? d.endingKey : "";
    const e: Ending = {
      key: endingKey,
      ...(typeof d.resultUrl === "string" ? { resultUrl: d.resultUrl } : {}),
      ...(typeof d.redirectUrl === "string" ? { redirectUrl: d.redirectUrl } : {}),
      pendingConfirmation: d.pendingConfirmation === true,
      guardianConsent: d.guardianConsent === true,
    };
    setEnding(e);
    setStatus("idle");
    try {
      storage("local")?.removeItem(resumeKey(slug));
    } catch {
      // Nothing stored.
    }
    const endingKind = def.endings.find((x) => x.key === endingKey)?.kind ?? "thank_you";
    if (d.completedNow === true && !emitted.current.has(sub.current!.id)) {
      emitted.current.add(sub.current!.id);
      const detail: CompletedDetail = { slug, kind: p.kind, locale, endingKind };
      if (p.mode === "embed" && parentOrigin) window.parent.postMessage({ type: "beam-form:completed", ...detail }, parentOrigin);
      else window.dispatchEvent(new CustomEvent("beam-form:completed", { detail }));
    }
    if (e.redirectUrl) {
      try {
        (p.mode === "embed" ? window.top ?? window : window).location.assign(e.redirectUrl);
      } catch {
        window.location.assign(e.redirectUrl);
      }
    }
  };

  const onNext = async () => {
    if (status === "saving" || status === "retrying") return;
    // L4: visibility in this section reads the answers of the sections before it.
    const v = validateSection(def, history, section.key, { ...answers, ...hiddenValues(def, query) }, scoring);
    const fieldErrors = v.ok ? {} : Object.fromEntries(Object.entries(v.fields).filter(([k]) => !known.has(k)));
    if (Object.keys(fieldErrors).length) {
      setErrors(fieldErrors);
      setFocusTick((t) => t + 1);
      return;
    }
    setErrors({});
    setStatus("saving");
    if (!(await ensureStarted())) return;
    if (movedByResume.current) {
      // The session resume moved to the saved section: continue there, nothing to save here.
      movedByResume.current = false;
      setStatus("idle");
      return;
    }
    const r = await send("save", { ...proof(), sectionKey: section.key, answers: { ...answers, ...(section.key === first ? hiddenValues(def, query) : {}) } });
    if (!r) return;
    if (r.status !== 200) return void failWith(r);
    const next = (r.data?.next ?? {}) as { sectionKey?: string; end?: boolean };
    if (next.sectionKey) {
      setHistory((h) => [...h, section.key]);
      setSectionKey(next.sectionKey);
      setStatus("idle");
      rootRef.current?.scrollIntoView?.({ block: "start" });
      return;
    }
    await submit();
  };

  const onBack = () => {
    const prev = history.at(-1);
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setSectionKey(prev);
    setErrors({});
  };

  const onResume = async (token: string) => {
    setResumeDismissed(true);
    try {
      const r = await call(`${api("resume")}?token=${encodeURIComponent(token)}`, { method: "GET" });
      if (r.status !== 200 || typeof r.data?.submissionId !== "string") throw new Error("resume");
      sub.current = { id: r.data.submissionId, resumeToken: token };
      setStarted(true);
      restore((r.data.answers ?? {}) as Answers, typeof r.data.currentSectionKey === "string" ? r.data.currentSectionKey : null, false);
    } catch {
      storage("local")?.removeItem(resumeKey(slug));
    }
  };

  const notYou = () => {
    setPrefill(null);
    setIdentityToken(null);
  };

  const endingDef = ending ? (def.endings.find((x) => x.key === ending.key) ?? def.endings[0]) : null;
  const l = (k: string) => labels[k] ?? k;
  const errorKeys = Object.keys(errors);

  return (
    <div ref={rootRef} lang={locale} className="mx-auto w-full max-w-2xl space-y-6 motion-safe:transition-all" data-beam-form-root={slug}>
      <div aria-live="polite" className="sr-only">
        {status === "saving" ? l("saving") : status === "retrying" ? l("retrying") : ""}
      </div>
      {ending && endingDef ? (
        <section className="space-y-4" aria-labelledby={`${idPrefix}-ending`}>
          <h2 id={`${idPrefix}-ending`} className="text-2xl font-semibold" tabIndex={-1}>
            {endingDef.title[locale]}
          </h2>
          <Markdown text={endingDef.body[locale] ?? ""} />
          {ending.pendingConfirmation ? <p role="status">{l("pending_confirmation")}</p> : null}
          {ending.guardianConsent ? <p role="status">{l("guardian_consent")}</p> : null}
          {ending.resultUrl ? (
            <a href={ending.resultUrl} target={p.mode === "embed" ? "_top" : undefined} className="inline-flex min-h-11 items-center rounded-md bg-primary px-5 font-medium text-primary-foreground">
              {l("view_result")}
            </a>
          ) : null}
          {ending.redirectUrl ? <p>{l("redirecting")}</p> : null}
        </section>
      ) : status === "closed" ? (
        <p role="alert" className="text-lg font-medium">
          {l("closed_title")}
        </p>
      ) : (
        <form
          noValidate
          aria-label={def.title[locale]}
          onSubmit={(e) => {
            e.preventDefault();
            void onNext();
          }}
          className="space-y-6"
        >
          {p.staffFirstName ? <p className="rounded-md bg-muted px-4 py-3 font-medium">{l("staff_banner").replace("{firstName}", p.staffFirstName)}</p> : null}
          {resumeOffer ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-4">
              <p className="flex-1">{l("resume_offer")}</p>
              <Button type="button" className="min-h-11" onClick={() => void onResume(resumeOffer)}>
                {l("resume_continue")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setResumeDismissed(true);
                  storage("local")?.removeItem(resumeKey(slug));
                }}
              >
                {l("resume_restart")}
              </Button>
            </div>
          ) : null}
          {prefill && prefill.known.length && !p.staffFirstName ? (
            <p className="text-sm">
              {l("prefill_summary").replace("{firstName}", prefill.firstName ?? "").replace("{email}", prefill.maskedEmail ?? "")}{" "}
              <button type="button" className="min-h-11 underline" onClick={notYou}>
                {l("not_you")}
              </button>
            </p>
          ) : null}
          {def.settings.showProgress ? (
            <div>
              <p className="text-sm text-muted-foreground">{l("progress").replace("{n}", String(step)).replace("{total}", String(total))}</p>
              <div className="mt-1 h-1.5 w-full rounded bg-muted" aria-hidden="true">
                <div className="h-1.5 rounded bg-primary" style={{ width: `${Math.round((step / total) * 100)}%` }} />
              </div>
            </div>
          ) : null}
          {errorKeys.length ? (
            <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive p-4 focus:outline-none" data-error-summary>
              <p className="font-medium">{l("error_summary")}</p>
              <ul className="mt-2 list-disc pl-5">
                {errorKeys.map((k) => (
                  <li key={k}>
                    <a href={`#${idPrefix}-${k}`} className="underline">
                      {(def.fields[k]?.label[locale] ?? k) + ": " + errorText(errors[k]!, labels)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {section.title?.[locale] ? <h2 className="text-xl font-semibold">{section.title[locale]}</h2> : null}
          {section.description?.[locale] ? <Markdown text={section.description[locale]} /> : null}
          {visibleFields.map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={answers[f.key] ?? undefined}
              onChange={(v) => setAnswer(f.key, v)}
              locale={locale}
              labels={labels}
              error={errors[f.key]}
              idPrefix={idPrefix}
              staffEntry={!!p.staffFirstName}
            />
          ))}
          <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
            <label htmlFor={`${idPrefix}-website`}>{l("honeypot")}</label>
            <input id={`${idPrefix}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </div>
          {status === "retrying" ? <p className="text-sm">{l("retrying")}</p> : null}
          {status === "failed" ? <p className="text-sm text-destructive">{l("failed")}</p> : null}
          {status === "rate_limited" ? <p className="text-sm text-destructive">{l("rate_limited")}</p> : null}
          <div className="flex flex-wrap gap-3">
            {history.length ? (
              <Button type="button" variant="outline" className="min-h-11 min-w-24" onClick={onBack}>
                {l("back")}
              </Button>
            ) : null}
            <Button type="submit" className="min-h-11 min-w-24" disabled={status === "saving" || status === "retrying"} aria-busy={status === "saving" || undefined}>
              {status === "failed" ? l("retry") : willEnd ? def.settings.submitLabel[locale] || l("submit") : l("next")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

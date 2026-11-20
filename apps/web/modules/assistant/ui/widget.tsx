"use client";

/**
 * The chat widget of the guide (site) and the coach (portal). A launcher bottom right opens a
 * panel (full screen on a phone). Answers stream in as NDJSON from `/api/public/assistant/chat`;
 * the agent's cards render under its answer: sessions with a booking button, a link button, the
 * contact form, the handoff note. The browser keeps a random visitor token in local storage (the
 * server stores only its hash); a returning visitor sees their open conversation again. While a
 * colleague has the conversation, new messages are polled every five seconds.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readStoredUtm } from "@beam/core/site";
import { setCoachCheckins } from "../actions";

export type AssistantWidgetLabels = {
  launcher: string;
  title: string;
  subtitle: string;
  greeting: string;
  starters: string[];
  placeholder: string;
  send: string;
  close: string;
  open: string;
  newChat: string;
  disclaimer: string;
  thinking: string;
  relayed: string;
  staff: string;
  helpful: string;
  notHelpful: string;
  book: string;
  /** "1 place left" and "# places left". */
  freeOne: string;
  freeMany: string;
  handoff: string;
  error: string;
  contact: { title: string; body: string; firstName: string; email: string; phone: string; newsletter: string; submit: string; privacy: string; error: string };
  checkins?: { label: string; hint: string };
};

type Card =
  | { type: "sessions"; sessions: { id: string; title: string; startsAt: string; kind: string; free: number; priceCents: number | null; href: string }[] }
  | { type: "link"; label: string; href: string }
  | { type: "contact" }
  | { type: "handoff" };

type Msg = { key: string; id: string | null; author: "visitor" | "assistant" | "staff"; body: string; cards: Card[]; createdAt: string | null; rating: number | null; streaming?: boolean };

type Stored = { token: string | null; conversationId: string | null };

const API = "/api/public/assistant";
const storageKey = (role: string) => `beam_assistant_${role}`;

function load(role: string): Stored {
  try {
    const raw = localStorage.getItem(storageKey(role));
    if (raw) return { token: null, conversationId: null, ...(JSON.parse(raw) as Partial<Stored>) };
  } catch {
    // Private mode or blocked storage: the chat works, it just forgets on reload.
  }
  return { token: null, conversationId: null };
}

function save(role: string, value: Stored): void {
  try {
    localStorage.setItem(storageKey(role), JSON.stringify(value));
  } catch {
    // Same as above.
  }
}

let keySeq = 0;
const nextKey = () => `m${++keySeq}`;

function Spark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M12 2.5c.4 3.9 1.6 6.9 3.4 8.6 1.7 1.8 4.7 3 8.6 3.4-3.9.4-6.9 1.6-8.6 3.4-1.8 1.7-3 4.7-3.4 8.6-.4-3.9-1.6-6.9-3.4-8.6C6.9 16.1 3.9 14.9 0 14.5c3.9-.4 6.9-1.6 8.6-3.4C10.4 9.4 11.6 6.4 12 2.5Z" transform="scale(.9) translate(1.3 -1)" />
    </svg>
  );
}

function Body({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const isList = lines.every((l) => /^\s*[-•*]\s+/.test(l));
        if (isList)
          return (
            <ul key={i} className="my-1 list-disc space-y-0.5 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*[-•*]\s+/, "").replace(/\*\*/g, "")}</li>
              ))}
            </ul>
          );
        return (
          <p key={i} className="whitespace-pre-wrap [&+p]:mt-2">
            {block.replace(/\*\*/g, "")}
          </p>
        );
      })}
    </>
  );
}

export function AssistantWidget({
  role,
  locale,
  labels,
  checkinsAllowed,
  privacyHref,
}: {
  role: "guide" | "coach";
  locale: "nl-BE" | "fr-BE" | "en";
  labels: AssistantWidgetLabels;
  checkinsAllowed?: boolean | null;
  privacyHref?: string;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [takenOver, setTakenOver] = useState(false);
  const [contactDone, setContactDone] = useState(false);
  const [checkins, setCheckins] = useState(!!checkinsAllowed);
  const stored = useRef<Stored>({ token: null, conversationId: null });
  const loaded = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const headers = useCallback((): HeadersInit => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (stored.current.token) h["x-assistant-token"] = stored.current.token;
    return h;
  }, []);

  const remember = useCallback(
    (patch: Partial<Stored>) => {
      stored.current = { ...stored.current, ...patch };
      save(role, stored.current);
    },
    [role],
  );

  // First open: the returning visitor's open conversation.
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    stored.current = load(role);
    if (!stored.current.token) return;
    void fetch(`${API}/history`, { method: "POST", headers: headers(), body: JSON.stringify({ role, conversationId: stored.current.conversationId }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { conversation: { id: string; takenOver: boolean; contactKnown: boolean } | null; messages: Omit<Msg, "key">[] } | null) => {
        if (!data?.conversation) return;
        remember({ conversationId: data.conversation.id });
        setTakenOver(data.conversation.takenOver);
        setContactDone(data.conversation.contactKnown);
        setMessages(data.messages.map((m) => ({ ...m, key: nextKey(), cards: m.cards ?? [] })));
      })
      .catch(() => {});
  }, [open, role, headers, remember]);

  useEffect(() => {
    if (open) setTimeout(() => field.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // A colleague has the conversation: poll for their replies.
  const wantsColleague = takenOver || messages.some((m) => m.cards.some((c) => c.type === "handoff"));
  useEffect(() => {
    if (!open || !wantsColleague || !stored.current.conversationId) return;
    const timer = window.setInterval(() => {
      const last = [...messages].reverse().find((m) => m.createdAt)?.createdAt ?? null;
      void fetch(`${API}/history`, { method: "POST", headers: headers(), body: JSON.stringify({ role, conversationId: stored.current.conversationId, after: last }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { conversation: { takenOver: boolean } | null; messages: Omit<Msg, "key">[] } | null) => {
          if (!data?.conversation) return;
          setTakenOver(data.conversation.takenOver);
          const fresh = data.messages.filter((m) => m.author !== "visitor");
          if (!fresh.length) return;
          setMessages((prev) => {
            const have = new Set(prev.map((p) => p.id).filter(Boolean));
            const add = fresh.filter((m) => !have.has(m.id)).map((m) => ({ ...m, key: nextKey(), cards: m.cards ?? [] }));
            return add.length ? [...prev, ...add] : prev;
          });
        })
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [open, wantsColleague, messages, headers, role]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      setBusy(true);
      setInput("");
      const replyKey = nextKey();
      setMessages((prev) => [
        ...prev,
        { key: nextKey(), id: null, author: "visitor", body: message, cards: [], createdAt: null, rating: null },
        { key: replyKey, id: null, author: "assistant", body: "", cards: [], createdAt: null, rating: null, streaming: true },
      ]);
      const patch = (fn: (m: Msg) => Msg) => setMessages((prev) => prev.map((m) => (m.key === replyKey ? fn(m) : m)));
      try {
        const utm = readStoredUtm();
        const origin = utm ? { ...Object.fromEntries(Object.entries(utm.utm).map(([k, v]) => [`utm_${k}`, String(v)])), landing: utm.landingPath } : null;
        const res = await fetch(`${API}/chat`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ message, conversationId: stored.current.conversationId, locale, role, page: window.location.pathname, origin }),
        });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let at: number;
          while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (!line) continue;
            const ev = JSON.parse(line) as { t: string; text?: string; card?: Card; token?: string; conversationId?: string; messageId?: string | null };
            if (ev.t === "session") remember({ conversationId: ev.conversationId ?? null, ...(ev.token ? { token: ev.token } : {}) });
            else if (ev.t === "delta") patch((m) => ({ ...m, body: m.body + (ev.text ?? "") }));
            else if (ev.t === "card" && ev.card) patch((m) => ({ ...m, cards: [...m.cards, ev.card!] }));
            else if (ev.t === "relayed") {
              setTakenOver(true);
              setMessages((prev) => prev.filter((m) => m.key !== replyKey));
            } else if (ev.t === "done") patch((m) => ({ ...m, id: ev.messageId ?? null, streaming: false, createdAt: new Date().toISOString() }));
          }
        }
        patch((m) => ({ ...m, streaming: false }));
      } catch {
        patch((m) => ({ ...m, streaming: false, body: m.body || labels.error }));
      } finally {
        setBusy(false);
        setTimeout(() => field.current?.focus(), 30);
      }
    },
    [busy, headers, labels.error, locale, remember, role],
  );

  const rate = (msg: Msg, rating: 1 | -1) => {
    if (!msg.id) return;
    setMessages((prev) => prev.map((m) => (m.key === msg.key ? { ...m, rating } : m)));
    void fetch(`${API}/event`, { method: "POST", headers: headers(), body: JSON.stringify({ type: "rating", messageId: msg.id, rating }) }).catch(() => {});
  };

  const clicked = (href: string) => {
    if (!stored.current.conversationId) return;
    void fetch(`${API}/event`, { method: "POST", headers: headers(), keepalive: true, body: JSON.stringify({ type: "click", conversationId: stored.current.conversationId, href }) }).catch(() => {});
  };

  const newChat = () => {
    remember({ conversationId: null });
    setMessages([]);
    setTakenOver(false);
  };

  const toggleCheckins = async () => {
    const next = !checkins;
    setCheckins(next);
    const r = await setCoachCheckins({ allowed: next });
    if (!r.ok) setCheckins(!next);
  };

  const fmtWhen = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const fmtPrice = (cents: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  const visitorSpoke = messages.some((m) => m.author === "visitor");

  return (
    <>
      {!open ? (
        <div className={`fixed right-4 z-30 sm:right-6 sm:bottom-6 ${role === "coach" ? "bottom-20" : "bottom-4"}`}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={labels.open}
            data-testid="assistant-launcher"
            className="site-gold inline-flex h-14 items-center gap-2.5 rounded-full pr-5 pl-4 text-sm font-semibold text-[#212842] shadow-[0_12px_32px_-10px_rgb(33_40_66/0.55)] transition hover:-translate-y-0.5"
          >
            <span className="grid size-8 place-items-center rounded-full bg-[#212842] text-[#e8c26a]">
              <Spark className="size-4" />
            </span>
            {labels.launcher}
          </button>
        </div>
      ) : null}

      {open ? (
        <section
          role="dialog"
          aria-label={labels.title}
          data-testid="assistant-panel"
          className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-[#fbf7ee] text-[#212842] sm:inset-auto sm:right-6 sm:bottom-6 sm:h-[min(680px,calc(100dvh-3rem))] sm:w-[400px] sm:rounded-[1.5rem] sm:shadow-[0_24px_64px_-24px_rgb(33_40_66/0.55)] sm:ring-1 sm:ring-[#212842]/10"
        >
          <header className="flex items-center gap-3 bg-[#212842] px-4 py-3.5 text-[#fffaef]">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#b57627,#f7cc78)] text-[#212842]">
              <Spark className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-display truncate text-lg leading-tight">{labels.title}</p>
              <p className="flex items-center gap-1.5 truncate text-xs text-[#fffaef]/65">
                <span className="size-1.5 rounded-full bg-[#7fd39a]" aria-hidden="true" />
                {labels.subtitle}
              </p>
            </div>
            {visitorSpoke ? (
              <button type="button" onClick={newChat} aria-label={labels.newChat} title={labels.newChat} className="grid size-9 place-items-center rounded-full text-[#fffaef]/75 hover:bg-[#fffaef]/10 hover:text-[#fffaef]">
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
            <button type="button" onClick={() => setOpen(false)} aria-label={labels.close} className="grid size-9 place-items-center rounded-full text-xl text-[#fffaef]/80 hover:bg-[#fffaef]/10">
              ×
            </button>
          </header>

          {role === "coach" && labels.checkins ? (
            <label className="flex cursor-pointer items-start gap-3 border-b border-[#212842]/10 bg-[#fffaef] px-4 py-2.5 text-xs">
              <input type="checkbox" checked={checkins} onChange={() => void toggleCheckins()} className="mt-0.5 size-4 accent-[#212842]" />
              <span>
                <span className="font-semibold">{labels.checkins.label}</span>
                <span className="block text-[#212842]/60">{labels.checkins.hint}</span>
              </span>
            </label>
          ) : null}

          <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
            <div className="max-w-[88%] rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 text-sm leading-relaxed shadow-[0_1px_2px_rgb(33_40_66/0.06)] ring-1 ring-[#212842]/[0.06]">{labels.greeting}</div>

            {messages.map((m) =>
              m.author === "visitor" ? (
                <div key={m.key} className="ml-auto max-w-[85%] rounded-2xl rounded-tr-md bg-[#212842] px-3.5 py-2.5 text-sm leading-relaxed text-[#fffaef]">
                  <p className="whitespace-pre-wrap">{m.body}</p>
                </div>
              ) : (
                <div key={m.key} className="max-w-[92%] space-y-2">
                  {m.author === "staff" ? <p className="text-[11px] font-semibold tracking-wide text-[#a0621e] uppercase">{labels.staff}</p> : null}
                  {m.body || m.streaming ? (
                    <div className={`rounded-2xl rounded-tl-md px-3.5 py-2.5 text-sm leading-relaxed shadow-[0_1px_2px_rgb(33_40_66/0.06)] ring-1 ${m.author === "staff" ? "bg-[#f6efdf] ring-[#d1a64a]/30" : "bg-white ring-[#212842]/[0.06]"}`}>
                      {m.body ? (
                        <Body text={m.body} />
                      ) : (
                        <span className="inline-flex items-center gap-2 text-[#212842]/55">
                          <span className="flex gap-1" aria-hidden="true">
                            {[0, 1, 2].map((d) => (
                              <span key={d} className="size-1.5 animate-pulse rounded-full bg-[#d1a64a]" style={{ animationDelay: `${d * 160}ms` }} />
                            ))}
                          </span>
                          {labels.thinking}
                        </span>
                      )}
                    </div>
                  ) : null}

                  {m.cards.map((card, i) =>
                    card.type === "sessions" ? (
                      <ul key={i} className="divide-y divide-[#212842]/[0.07] overflow-hidden rounded-2xl bg-white ring-1 ring-[#212842]/[0.08]">
                        {card.sessions.map((s) => (
                          <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                            <span className={`grid size-10 shrink-0 place-items-center rounded-xl text-base ${s.kind === "night" ? "bg-[#212842] text-[#e8c26a]" : "bg-[#f6efdf] text-[#a0621e]"}`} aria-hidden="true">
                              {s.kind === "night" ? "☾" : "☀"}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-sm font-semibold">{fmtWhen(s.startsAt)}</span>
                                {s.priceCents != null ? <span className="shrink-0 text-xs font-semibold tabular-nums text-[#a0621e]">{fmtPrice(s.priceCents)}</span> : null}
                              </span>
                              <span className="block truncate text-xs text-[#212842]/60">
                                {s.title} · {s.free === 1 ? labels.freeOne : labels.freeMany.replace("#", String(s.free))}
                              </span>
                            </span>
                            <a href={s.href} onClick={() => clicked(s.href)} className="shrink-0 rounded-full bg-[#212842] px-3.5 py-1.5 text-xs font-semibold text-[#fffaef] hover:bg-[#2c3557]">
                              {labels.book}
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : card.type === "link" ? (
                      <a key={i} href={card.href} onClick={() => clicked(card.href)} className="site-gold inline-flex h-11 items-center gap-2 rounded-full pr-1.5 pl-5 text-sm font-semibold text-[#212842]">
                        {card.label}
                        <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-[#212842] text-[#fffaef]">
                          →
                        </span>
                      </a>
                    ) : card.type === "handoff" ? (
                      <p key={i} className="flex items-start gap-2 rounded-2xl bg-[#e7f1ea] px-3.5 py-2.5 text-sm text-[#2f6d44]">
                        <span aria-hidden="true">✓</span>
                        {labels.handoff}
                      </p>
                    ) : contactDone ? null : (
                      <ContactCard
                        key={i}
                        labels={labels.contact}
                        onSubmit={async (form) => {
                          const res = await fetch(`${API}/contact`, {
                            method: "POST",
                            headers: headers(),
                            body: JSON.stringify({ ...form, conversationId: stored.current.conversationId, locale }),
                          });
                          if (!res.ok) return false;
                          const data = (await res.json()) as { message?: Omit<Msg, "key"> };
                          setContactDone(true);
                          if (data.message) setMessages((prev) => [...prev, { ...data.message!, key: nextKey(), cards: [] }]);
                          return true;
                        }}
                        privacyHref={privacyHref}
                      />
                    ),
                  )}

                  {m.author === "assistant" && m.id && !m.streaming ? (
                    <div className="flex gap-1 pl-1">
                      {([1, -1] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => rate(m, r)}
                          aria-label={r === 1 ? labels.helpful : labels.notHelpful}
                          aria-pressed={m.rating === r}
                          className="grid size-7 place-items-center rounded-full text-xs text-[#212842]/35 hover:bg-[#212842]/5 hover:text-[#212842]/70 aria-pressed:bg-[#212842]/10 aria-pressed:text-[#212842]"
                        >
                          {r === 1 ? "👍" : "👎"}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ),
            )}

            {takenOver ? <p className="rounded-2xl bg-[#f6efdf] px-3.5 py-2.5 text-xs text-[#7a4a12]">{labels.relayed}</p> : null}

            {!visitorSpoke ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {labels.starters.map((s) => (
                  <button key={s} type="button" onClick={() => void send(s)} className="rounded-full bg-white px-3.5 py-2 text-left text-sm ring-1 ring-[#212842]/15 transition hover:ring-[#212842]/40">
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="border-t border-[#212842]/10 bg-white px-3 pt-3 pb-2"
          >
            <div className="flex items-end gap-2 rounded-2xl bg-[#fbf7ee] p-1.5 ring-1 ring-[#212842]/10 focus-within:ring-[#212842]/35">
              <textarea
                ref={field}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={1}
                maxLength={2000}
                placeholder={labels.placeholder}
                aria-label={labels.placeholder}
                className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-[#212842]/40 sm:text-sm"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label={labels.send}
                className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#212842] text-[#fffaef] transition disabled:opacity-35"
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                  <path d="M5 12h13M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <p className="px-1 pt-1.5 text-center text-[11px] text-[#212842]/45">{labels.disclaimer}</p>
          </form>
        </section>
      ) : null}
    </>
  );
}

function ContactCard({
  labels,
  onSubmit,
  privacyHref,
}: {
  labels: AssistantWidgetLabels["contact"];
  onSubmit: (form: { firstName: string; email: string; phone: string | null; newsletter: boolean; website: string }) => Promise<boolean>;
  privacyHref?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const input = "h-11 w-full rounded-xl bg-[#fbf7ee] px-3 text-base ring-1 ring-[#212842]/12 outline-none focus:ring-[#212842]/40 sm:text-sm";
  return (
    <form
      className="space-y-2.5 rounded-2xl bg-white p-3.5 ring-1 ring-[#d1a64a]/45"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const str = (k: string) => {
          const v = fd.get(k);
          return typeof v === "string" ? v : "";
        };
        setBusy(true);
        setError(false);
        void onSubmit({ firstName: str("firstName"), email: str("email"), phone: str("phone") || null, newsletter: fd.get("newsletter") === "on", website: str("website") })
          .catch(() => false)
          .then((ok) => {
            setBusy(false);
            if (!ok) setError(true);
          });
      }}
    >
      <div>
        <p className="font-semibold">{labels.title}</p>
        <p className="text-xs text-[#212842]/60">{labels.body}</p>
      </div>
      <input name="firstName" required maxLength={80} autoComplete="given-name" placeholder={labels.firstName} aria-label={labels.firstName} className={input} />
      <input name="email" type="email" required maxLength={200} autoComplete="email" placeholder={labels.email} aria-label={labels.email} className={input} />
      <input name="phone" type="tel" maxLength={40} autoComplete="tel" placeholder={labels.phone} aria-label={labels.phone} className={input} />
      <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
      <label className="flex cursor-pointer items-start gap-2 text-xs text-[#212842]/75">
        <input name="newsletter" type="checkbox" className="mt-0.5 size-4 accent-[#212842]" />
        {labels.newsletter}
      </label>
      {error ? <p className="text-xs text-[#a03d2a]">{labels.error}</p> : null}
      <button type="submit" disabled={busy} className="site-gold h-11 w-full rounded-full text-sm font-semibold text-[#212842] disabled:opacity-60">
        {labels.submit}
      </button>
      <p className="text-[11px] text-[#212842]/50">
        🔒 {labels.privacy}
        {privacyHref ? (
          <>
            {" "}
            <a href={privacyHref} className="underline">
              Privacy
            </a>
          </>
        ) : null}
      </p>
    </form>
  );
}

"use client";

/**
 * The assistant settings form: on/off per role, model, fallback, reasoning effort and answer length
 * per role (any model of the price list), the spend caps, the abuse limits, when to offer the
 * contact form, the tone, and the price list itself (a new gateway model is one row). Saves the
 * whole setting with `saveAssistantSettings`; the next message uses it.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveAssistantSettings } from "../../actions";
import { ASSISTANT_EFFORTS, type AssistantSettingValue } from "../../shared";

type Labels = Record<string, string>;

export function SettingsForm({ initial, labels }: { initial: AssistantSettingValue; labels: Labels }) {
  const router = useRouter();
  const [v, setV] = useState<AssistantSettingValue>(initial);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const L = (k: string) => labels[k] ?? k;
  const box = "h-9 rounded-lg border bg-card px-3 text-sm";
  const card = "grid gap-4 rounded-[1.25rem] bg-card p-5 shadow-[0_1px_2px_rgb(33_40_66/0.04),0_12px_32px_-18px_rgb(33_40_66/0.22)]";
  const num = (value: number, onChange: (n: number) => void, step = 1) => (
    <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className={`${box} w-full tabular-nums`} />
  );
  const field = (label: string, control: React.ReactNode) => (
    <label className="grid min-w-0 gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {control}
    </label>
  );
  const role = (r: "guide" | "coach" | "analyst") => {
    const cfg = v.roles[r];
    const set = (patch: Partial<typeof cfg>) => setV({ ...v, roles: { ...v.roles, [r]: { ...cfg, ...patch } } });
    return (
      <div key={r} className="grid gap-3 rounded-2xl border p-4">
        <p className="font-semibold">
          {L(`role.${r}`)} <code className="ml-1 text-xs font-normal text-muted-foreground">{cfg.model}</code>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {field(
            L("model"),
            <select value={cfg.model} onChange={(e) => set({ model: e.target.value })} className={`${box} w-full min-w-0`}>
              {v.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>,
          )}
          {field(
            L("fallback"),
            <select value={cfg.fallback ?? ""} onChange={(e) => set({ fallback: e.target.value || null })} className={`${box} w-full min-w-0`}>
              <option value="">{L("none")}</option>
              {v.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>,
          )}
          {field(
            L("effort"),
            <select value={cfg.effort} onChange={(e) => set({ effort: e.target.value as typeof cfg.effort })} className={`${box} w-full min-w-0`}>
              {ASSISTANT_EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {L(`effort_${e}`)}
                </option>
              ))}
            </select>,
          )}
          {field(L("maxTokens"), num(cfg.max_tokens, (n) => set({ max_tokens: n })))}
        </div>
      </div>
    );
  };

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveAssistantSettings({ ...v, advice: { ...v.advice, flows: v.advice.flows.filter(Boolean) } });
          setStatus(r.ok ? "saved" : "error");
          if (r.ok) router.refresh();
        });
      }}
    >
      <section className={card}>
        <h2 className="text-lg font-semibold">{L("switches")}</h2>
        {(["enabled", "coach_enabled"] as const).map((k) => (
          <label key={k} className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border px-4 py-3">
            <span className="text-sm font-medium">{L(k === "enabled" ? "enabled" : "coachEnabled")}</span>
            <input type="checkbox" checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} className="size-5 accent-[#212842]" />
          </label>
        ))}
      </section>

      <section className={card}>
        <h2 className="text-lg font-semibold">{L("roles")}</h2>
        <div className="grid gap-3 xl:grid-cols-3">{(["guide", "coach", "analyst"] as const).map(role)}</div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={card}>
          <h2 className="text-lg font-semibold">{L("budget")}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {field(L("daily"), num(v.daily_budget_cents, (n) => setV({ ...v, daily_budget_cents: n })))}
            {field(L("monthly"), num(v.monthly_budget_cents, (n) => setV({ ...v, monthly_budget_cents: n })))}
          </div>
          <h3 className="pt-2 font-semibold">{L("limits")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {field(L("perMinute"), num(v.limits.per_minute, (n) => setV({ ...v, limits: { ...v.limits, per_minute: n } })))}
            {field(L("perDay"), num(v.limits.per_day, (n) => setV({ ...v, limits: { ...v.limits, per_day: n } })))}
            {field(L("perConversation"), num(v.limits.per_conversation, (n) => setV({ ...v, limits: { ...v.limits, per_conversation: n } })))}
            {field(L("perIp"), num(v.limits.per_ip_minute, (n) => setV({ ...v, limits: { ...v.limits, per_ip_minute: n } })))}
          </div>
        </section>
        <section className={card}>
          <h2 className="text-lg font-semibold">{L("sales")}</h2>
          {field(L("contactAfter"), num(v.contact_after_messages, (n) => setV({ ...v, contact_after_messages: n })))}
          {field(L("tone"), <textarea value={v.tone} maxLength={2000} rows={5} onChange={(e) => setV({ ...v, tone: e.target.value })} className="rounded-xl border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />)}
        </section>
      </div>

      <section className={card}>
        <h2 className="text-lg font-semibold">{L("adviceTitle")}</h2>
        <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border px-4 py-3">
          <span className="text-sm font-medium">{L("autoApply")}</span>
          <input type="checkbox" checked={v.advice.auto_apply} onChange={(e) => setV({ ...v, advice: { ...v.advice, auto_apply: e.target.checked } })} className="size-5 shrink-0 accent-[#212842]" />
        </label>
        {field(
          L("adviceFlows"),
          <textarea
            value={v.advice.flows.join("\n")}
            rows={5}
            onChange={(e) => setV({ ...v, advice: { ...v.advice, flows: e.target.value.split("\n").map((x) => x.trim()) } })}
            onBlur={() => setV({ ...v, advice: { ...v.advice, flows: v.advice.flows.filter(Boolean) } })}
            className="rounded-xl border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />,
        )}
      </section>

      <section className={card}>
        <h2 className="text-lg font-semibold">{L("prices")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">ID</th>
                <th className="py-1 pr-2 font-medium">{L("model")}</th>
                <th className="py-1 pr-2 font-medium">{L("in")}</th>
                <th className="py-1 pr-2 font-medium">{L("out")}</th>
                <th className="py-1 pr-2 font-medium">{L("cacheRead")}</th>
                <th className="py-1 pr-2 font-medium">{L("cacheWrite")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {v.models.map((m, i) => {
                const set = (patch: Partial<typeof m>) => setV({ ...v, models: v.models.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <tr key={i} className="border-t">
                    <td className="py-1.5 pr-2">
                      <input value={m.id} onChange={(e) => set({ id: e.target.value })} className={`${box} w-full font-mono text-xs`} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input value={m.label} onChange={(e) => set({ label: e.target.value })} className={`${box} w-full`} />
                    </td>
                    {(["in", "out", "cache_read", "cache_write"] as const).map((k) => (
                      <td key={k} className="py-1.5 pr-2">
                        {num(m[k], (n) => set({ [k]: n }), 0.01)}
                      </td>
                    ))}
                    <td className="py-1.5">
                      <button type="button" onClick={() => setV({ ...v, models: v.models.filter((_, j) => j !== i) })} className="rounded-full px-2 py-1 text-muted-foreground hover:bg-accent" aria-label="remove">
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={() => setV({ ...v, models: [...v.models, { id: "provider/model", label: "New model", in: 0, out: 0, cache_read: 0, cache_write: 0 }] })} className="justify-self-start rounded-full border px-3 py-1.5 text-sm hover:bg-accent">
          + {L("model")}
        </button>
      </section>

      <div className="sticky bottom-4 z-10 flex w-fit items-center gap-3 rounded-full bg-card/95 p-1.5 pr-5 shadow-lg ring-1 ring-black/5 backdrop-blur">
        <button type="submit" disabled={pending} className="site-gold rounded-full px-6 py-2.5 text-sm font-semibold text-[#212842] disabled:opacity-60">
          {L("save")}
        </button>
        {status === "saved" ? <span className="text-sm text-[#2f6d44]">✓ {L("saved")}</span> : null}
        {status === "error" ? <span className="text-sm text-destructive">{L("error")}</span> : null}
      </div>
    </form>
  );
}

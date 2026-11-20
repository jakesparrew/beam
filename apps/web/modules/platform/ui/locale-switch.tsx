"use client";

/**
 * NL / FR / EN in the admin header: saves the staff member's own locale (`users.update_self`,
 * the same as `/admin/account`) and re-renders the back-office in it.
 */
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { updateMyProfile } from "../actions";

export function AdminLocaleSwitch({ name, locale, locales, label }: { name: string; locale: string; locales: { value: string; short: string; label: string }[]; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div role="group" aria-label={label} className="flex items-center rounded-full border border-border bg-card p-0.5 text-xs font-semibold" data-testid="admin-locale-switch">
      {locales.map((l) => (
        <button
          key={l.value}
          type="button"
          title={l.label}
          aria-pressed={l.value === locale}
          disabled={pending}
          onClick={() =>
            start(async () => {
              if (l.value === locale) return;
              const result = await updateMyProfile({ name, locale: l.value });
              if (result.ok) router.refresh();
            })
          }
          className={`rounded-full px-2.5 py-1 transition-colors ${l.value === locale ? "bg-[#212842] text-white" : "text-muted-foreground hover:text-foreground"} disabled:opacity-60`}
        >
          {l.short}
        </button>
      ))}
    </div>
  );
}

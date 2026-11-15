"use client";

/**
 * The header's account link. Server-rendered as "My account" (public pages stay cacheable); after
 * load it asks `/api/public/me` who is signed in and becomes "Hi <name>" with an initial, linking
 * customers to their account and staff to the back-office.
 */
import { useEffect, useState } from "react";

type Me = { firstName: string; audience: "customer" | "staff" } | null;

export function AccountLink({ accountHref, label, helloTemplate, className }: { accountHref: string; label: string; helloTemplate: string; className?: string }) {
  const [me, setMe] = useState<Me>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/public/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
      .then((v) => alive && setMe(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const href = me?.audience === "staff" ? "/admin" : accountHref;
  return (
    <a href={href} className={className} data-signed-in={me ? "true" : undefined}>
      {me ? (
        <>
          <span aria-hidden="true" className="inline-flex size-7 items-center justify-center rounded-full bg-[#ffd76a] text-xs font-semibold text-[#212842]">
            {me.firstName.charAt(0).toUpperCase()}
          </span>
          {helloTemplate.replace("{name}", me.firstName)}
        </>
      ) : (
        label
      )}
    </a>
  );
}

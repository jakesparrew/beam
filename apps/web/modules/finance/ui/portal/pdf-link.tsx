"use client";
/**
 * The PDF download of a portal document (finance spec section 5): a link to the portal PDF route
 * once rendered; "Being prepared" while `pdf_status = 'pending'`, refreshing the page once after
 * 5 seconds.
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function PortalPdfLink({
  href,
  ready,
  pending,
  label,
  preparingLabel,
  className,
}: {
  href: string;
  ready: boolean;
  pending: boolean;
  label: string;
  preparingLabel: string;
  className?: string;
}) {
  const router = useRouter();
  useEffect(() => {
    if (ready || !pending) return;
    const key = `finance-pdf-refresh:${href}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Storage may be unavailable; refresh once per mount instead.
    }
    const timer = window.setTimeout(() => router.refresh(), 5000);
    return () => window.clearTimeout(timer);
  }, [href, ready, pending, router]);

  if (ready) {
    return (
      <a href={href} className={className ?? "underline"} download>
        {label}
      </a>
    );
  }
  return (
    <span className="text-sm text-muted-foreground" role="status">
      {pending ? preparingLabel : "–"}
    </span>
  );
}

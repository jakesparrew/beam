"use client";

import { useState } from "react";
import { cn } from "@beam/ui";

/** A small "Copy" button that puts `value` on the clipboard and confirms for two seconds. */
export function CopyButton({ value, label, copiedLabel, className }: { value: string; label: string; copiedLabel: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className={cn("inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-card px-3 text-[0.75rem] font-semibold hover:bg-muted", copied && "border-[var(--status-ok)] text-[var(--status-ok)]", className)}
      aria-live="polite"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

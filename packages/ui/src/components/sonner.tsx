"use client";

import type { CSSProperties } from "react";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

/**
 * Toast host (sonner), themed with the BEAM tokens. Mount once per shell; call
 * `toast.success(message)` / `toast.error(message)` from client code. The theme
 * follows the system unless the caller passes `theme`.
 */
export function Toaster({ theme = "system", ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { toast };

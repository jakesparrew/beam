import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { Button } from "./components/button";

export type ErrorStateProps = {
  /** For example "Something went wrong". */
  title: ReactNode;
  description?: ReactNode;
  /** The request id to quote to support (shown in monospace, selectable). */
  requestId?: string | null;
  /** Label before the request id, for example "Request id". */
  requestIdLabel?: string;
  /** Retry control: `onClick` (route `error.tsx` passes its `reset`) or an `href`. */
  retry?: { label: string; onClick?: () => void; href?: string };
  className?: string;
};

/**
 * The shared error panel of route `error.tsx` files: message, request id and a retry
 * button. Announced politely to screen readers (`role="alert"`).
 */
export function ErrorState({
  title,
  description,
  requestId,
  requestIdLabel,
  retry,
  className,
}: ErrorStateProps) {
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40 bg-card px-6 py-12 text-center",
        className,
      )}
    >
      <CircleAlertIcon className="size-8 text-destructive" aria-hidden />
      <p className="text-base font-medium text-card-foreground">{title}</p>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {requestId ? (
        <p className="text-sm text-muted-foreground">
          {requestIdLabel ? <span>{requestIdLabel}: </span> : null}
          <code className="font-mono text-foreground select-all">
            {requestId}
          </code>
        </p>
      ) : null}
      {retry ? (
        retry.href ? (
          <Button asChild variant="outline" className="mt-2">
            <a href={retry.href}>{retry.label}</a>
          </Button>
        ) : (
          <Button variant="outline" className="mt-2" onClick={retry.onClick}>
            {retry.label}
          </Button>
        )
      ) : null}
    </div>
  );
}

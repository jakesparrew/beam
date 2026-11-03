import type { ReactNode } from "react";
import { cn } from "./cn";

export type EmptyStateProps = {
  /** The screen's named empty-state sentence, for example "No dead jobs. Everything ran." */
  title: ReactNode;
  description?: ReactNode;
  /** The next action (a button or link). */
  action?: ReactNode;
  /** Decorative icon (hidden from assistive technology). */
  icon?: ReactNode;
  className?: string;
};

/** The empty state of a list or panel; every string comes from the caller. */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="text-muted-foreground [&_svg]:size-8"
        >
          {icon}
        </div>
      ) : null}
      <p className="text-base font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

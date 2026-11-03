import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "./cn";
import { Label } from "./components/label";

type ControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
};

export type FormFieldProps = {
  /** Visible label. Required: every input has a label (PL-90). */
  label: ReactNode;
  /** Error message; linked to the control through `aria-describedby` and sets `aria-invalid`. */
  error?: string | null;
  /** Help text shown under the control, also linked through `aria-describedby`. */
  hint?: ReactNode;
  /** Marks the control as required (`aria-required`) and appends `requiredMark` to the label. */
  required?: boolean;
  /** Text after the label of a required field, for example " *" (strings come from the app). */
  requiredMark?: string;
  /** Id of the control; generated when omitted (an `id` already on the child wins). */
  id?: string;
  className?: string;
  /** Exactly one form control (`Input`, `Textarea`, `SelectTrigger`, `Checkbox`, ...). */
  children: ReactElement<ControlProps>;
};

/**
 * A labelled form control with hint and error. It wires `htmlFor`/`id`,
 * `aria-describedby` (hint, then error) and `aria-invalid` onto its single child, so
 * screen readers announce the error with the field. Works in server and client components.
 */
export function FormField({
  label,
  error,
  hint,
  required,
  requiredMark,
  id,
  className,
  children,
}: FormFieldProps) {
  const generated = useId();
  const childProps: ControlProps = isValidElement(children)
    ? children.props
    : {};
  const controlId =
    childProps.id ?? id ?? `field-${generated.replace(/:/g, "")}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy =
    [childProps["aria-describedby"], hintId, errorId]
      .filter(Boolean)
      .join(" ") || undefined;

  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : childProps["aria-invalid"],
        "aria-required": required ? true : childProps["aria-required"],
      })
    : children;

  return (
    <div
      data-slot="form-field"
      data-invalid={error ? "true" : undefined}
      className={cn("grid gap-2", className)}
    >
      <Label htmlFor={controlId} className={cn(error && "text-destructive")}>
        {label}
        {required && requiredMark ? (
          <span aria-hidden="true">{requiredMark}</span>
        ) : null}
      </Label>
      {control}
      {hint ? (
        <p
          id={hintId}
          data-slot="form-field-hint"
          className="text-sm text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          data-slot="form-field-error"
          className="text-sm font-medium text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "./cn";
import { Button } from "./components/button";

export type StepFormLabels = {
  /** "Next" */
  next: string;
  /** "Back" */
  previous: string;
  /** "Step {current} of {total}", both placeholders left in. */
  progress: string;
  /** Title of the last step, for example "Review". */
  review: string;
  /** One line under the review title, for example "Check your answers, then save." */
  reviewIntro: string;
  /** "Edit", on each section of the review. */
  edit: string;
  /** "or press Enter", next to the Next button. */
  enterHint: string;
  /** Review value of a ticked and an unticked checkbox. */
  yes: string;
  no: string;
};

export type StepFormProps = Omit<ComponentProps<"form">, "children"> & {
  /** Turns the sections into steps. Without labels the form shows every section at once (edit pages). */
  labels?: StepFormLabels | null;
  /** The submit row (the form's own submit buttons): under the sections, or on the review step. */
  footer: ReactNode;
  /** The form's content; each `<fieldset data-step>` with a `<legend>` becomes one step. */
  children: ReactNode;
};

type Answer = { label: string; value: string };
type Section = { title: string; answers: Answer[] };

const STEP = "fieldset[data-step]";
// Pickers are buttons: Radix Select (`role=combobox`) and our Combobox (`aria-haspopup=listbox`).
const CONTROLS = "input, select, textarea, [role='checkbox'], [role='radio'], [role='switch'], button[role='combobox'], button[aria-haspopup='listbox']";
/** A group that states its own review answer (a list of chips, say) instead of its controls. */
const OWN_ANSWER = "[data-review-value]";
const SKIPPED_INPUTS = ["hidden", "submit", "button", "reset", "image"];

/** Text of a node without its aria-hidden parts (the required mark) and without nested controls. */
function textOf(node: Node | null | undefined): string {
  if (!node) return "";
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? "";
    else if (child instanceof Element && child.getAttribute("aria-hidden") !== "true" && !child.matches("input, select, textarea")) out += ` ${textOf(child)} `;
  });
  return out.replace(/\s+/g, " ").trim();
}

/** The accessible name of a control: aria-labelledby, aria-label, then its <label>. */
function labelOf(el: HTMLElement): string {
  const ids = el.getAttribute("aria-labelledby");
  if (ids) return ids.split(/\s+/).map((id) => textOf(el.ownerDocument.getElementById(id))).join(" ").trim();
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const labels = (el as HTMLInputElement).labels;
  return labels?.length ? textOf(labels[0]) : "";
}

function valueOf(el: HTMLElement): string {
  if (el instanceof HTMLSelectElement) {
    return Array.from(el.selectedOptions)
      .filter((o) => o.value !== "")
      .map((o) => o.text.trim())
      .join(", ");
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return el.value ? "••••••" : "";
    if (el.type === "file") return Array.from(el.files ?? [], (f) => f.name).join(", ");
    if (el.type === "datetime-local") return el.value.replace("T", " ");
    return el.value.trim();
  }
  if (el instanceof HTMLTextAreaElement) return el.value.trim();
  // A picker without a choice shows its placeholder (`data-placeholder`, as Radix Select does).
  return el.hasAttribute("data-placeholder") ? "" : textOf(el);
}

/** Checked state of a checkbox, radio or switch; null for every other control. */
function checkedOf(el: HTMLElement): boolean | null {
  if (el instanceof HTMLInputElement) return el.type === "checkbox" || el.type === "radio" ? el.checked : null;
  return el.matches("[role='checkbox'], [role='radio'], [role='switch']") ? el.getAttribute("aria-checked") === "true" : null;
}

const isRadio = (el: HTMLElement) => (el instanceof HTMLInputElement && el.type === "radio") || el.getAttribute("role") === "radio";

/** The answers of one step: one row per labelled control, one row per group of choices. */
function answersOf(step: HTMLFieldSetElement, labels: StepFormLabels): Answer[] {
  const answers: Answer[] = [];
  const groups = new Map<Element, Answer>();
  step.querySelectorAll<HTMLElement>(`${CONTROLS}, ${OWN_ANSWER}`).forEach((el) => {
    if (el.matches(OWN_ANSWER)) {
      if (!el.parentElement?.closest(OWN_ANSWER)) answers.push({ label: textOf(el.querySelector(":scope > legend")) || labelOf(el), value: el.dataset.reviewValue ?? "" });
      return;
    }
    if (el.closest(`[aria-hidden='true'], ${OWN_ANSWER}`)) return;
    if (el instanceof HTMLInputElement && SKIPPED_INPUTS.includes(el.type)) return;
    const checked = checkedOf(el);
    // Choices in a group answer once with the group's legend (radios right in a step: the step's).
    const group = checked === null ? null : el.closest("fieldset");
    if (group && (group !== step || isRadio(el))) {
      let answer = groups.get(group);
      if (!answer) {
        answer = { label: textOf(group.querySelector(":scope > legend")), value: "" };
        groups.set(group, answer);
        answers.push(answer);
      }
      if (checked) answer.value = [answer.value, labelOf(el)].filter(Boolean).join(", ");
      return;
    }
    const label = labelOf(el);
    if (!label) return;
    answers.push({ label, value: checked === null ? valueOf(el) : checked ? labels.yes : labels.no });
  });
  return answers.map((a) => ({ ...a, value: a.value || "—" }));
}

/**
 * A long form one section per screen (owner review, November 2026: "Typeform-style"). Every
 * `<fieldset data-step>` becomes a step with a slim progress bar, its legend as the heading, Next
 * and Back; Enter moves on, and Next first checks the step's fields with the browser's own
 * constraint validation. A last review step lists the answers with the form's own submit row.
 * It enhances a plain `<form>`: the server render (and a browser without JS) shows every section
 * with the submit row, and `action`, `onSubmit` and the field names pass through untouched.
 */
export function StepForm({ labels, footer, children, className, onKeyDown, onSubmit, onInvalid, ...props }: StepFormProps) {
  const form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const invalidSeen = useRef("");
  const [titles, setTitles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [review, setReview] = useState<Section[]>([]);
  const enhanced = !!labels && titles.length > 0;
  const onReview = enhanced && index >= titles.length;

  const steps = () => Array.from(form.current?.querySelectorAll<HTMLFieldSetElement>(STEP) ?? []);

  // After every render (no dependency list on purpose): show the current step only and keep the
  // titles in step with the legends, which live in the DOM the children render (a form may add or
  // drop a section as its answers change). Reading that DOM back is the external sync effects are
  // for; the functional update returns the same array when nothing changed, so it settles at once.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after every render on purpose
  useLayoutEffect(() => {
    const sets = steps();
    const active = !!labels && sets.length > 0;
    sets.forEach((fs, i) => {
      fs.hidden = active && i !== index;
    });
    const next = active ? sets.map((fs) => textOf(fs.querySelector(":scope > legend"))) : [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above: syncing from the rendered DOM
    setTitles((cur) => (cur.join("\n") === next.join("\n") ? cur : next));
    if (!active) return;
    if (index > sets.length) setIndex(sets.length);
    // A field the save marked invalid (a server answer) sits on a hidden step: show that step.
    const invalid = sets.map((fs) => Array.from(fs.querySelectorAll("[aria-invalid='true']"), (e) => e.id || e.getAttribute("name") || "?").join(","));
    const key = invalid.join("|");
    if (key !== invalidSeen.current) {
      invalidSeen.current = key;
      const at = invalid.findIndex(Boolean);
      if (at >= 0 && at !== index) {
        moved.current = true;
        setIndex(at);
      }
    }
  });

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    heading.current?.focus();
  }, [index]);

  function go(target: number) {
    if (!labels) return;
    const sets = steps();
    if (target >= sets.length) setReview(sets.map((fs, i) => ({ title: titles[i] ?? "", answers: answersOf(fs, labels) })));
    moved.current = true;
    setIndex(Math.max(0, Math.min(target, sets.length)));
  }

  function next() {
    const current = steps()[index];
    for (const el of Array.from(current?.elements ?? [])) {
      const control = el as HTMLInputElement;
      if (typeof control.checkValidity === "function" && !control.checkValidity()) {
        control.reportValidity();
        control.focus();
        return;
      }
    }
    go(index + 1);
  }

  function keyDown(event: KeyboardEvent<HTMLFormElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || !enhanced || onReview || event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    event.preventDefault();
    next();
  }

  function submit(event: Parameters<NonNullable<ComponentProps<"form">["onSubmit"]>>[0]) {
    if (enhanced && !onReview) {
      event.preventDefault();
      next();
      return;
    }
    onSubmit?.(event);
  }

  // The browser refused the submit over a field on a hidden step: show the first such step.
  function invalid(event: FormEvent<HTMLFormElement>) {
    onInvalid?.(event);
    if (!enhanced) return;
    const at = steps().findIndex((fs) => Array.from(fs.elements).some((el) => !(el as HTMLInputElement).validity?.valid));
    if (at >= 0 && at !== index) {
      moved.current = true;
      setIndex(at);
    }
  }

  const total = titles.length + 1;
  const ui = enhanced ? labels : null;
  const back = ui && index > 0 ? (
    <Button type="button" variant="ghost" className="ml-auto" onClick={() => go(index - 1)} data-testid="step-form-previous">
      {ui.previous}
    </Button>
  ) : null;

  return (
    <form
      ref={form}
      data-slot="step-form"
      data-enhanced={enhanced ? "" : undefined}
      className={cn("grid gap-6", enhanced && "[&_fieldset[data-step]>legend]:sr-only", className)}
      onKeyDown={keyDown}
      onSubmit={submit}
      onInvalid={invalid}
      {...props}
    >
      {ui ? (
        <div data-slot="step-form-progress" className="grid gap-3">
          <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-ring transition-[width] duration-300" style={{ width: `${Math.round(((index + 1) / total) * 100)}%` }} />
          </div>
          <div className="grid gap-1">
            <p aria-live="polite" className="text-xs font-medium text-muted-foreground">
              {ui.progress.replace("{current}", String(index + 1)).replace("{total}", String(total))}
            </p>
            <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
              {onReview ? ui.review : titles[index]}
            </h2>
            {onReview ? <p className="text-[0.8125rem] text-muted-foreground">{ui.reviewIntro}</p> : null}
          </div>
        </div>
      ) : null}
      {children}
      {ui && onReview ? (
        <div data-slot="step-form-review" className="grid gap-3">
          {review.map((section, i) => (
            <section key={i} aria-label={section.title} className="rounded-lg border border-border">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
                <h3 className="text-[0.8125rem] font-semibold">{section.title}</h3>
                <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => go(i)} aria-label={`${ui.edit}: ${section.title}`}>
                  {ui.edit}
                </Button>
              </div>
              <dl className="grid gap-x-4 gap-y-1.5 px-4 py-3 text-[0.8125rem] sm:grid-cols-[minmax(8rem,13rem)_1fr]">
                {section.answers.map((a, j) => (
                  <Fragment key={j}>
                    <dt className="text-muted-foreground">{a.label}</dt>
                    <dd className="line-clamp-3 min-w-0 break-words">{a.value}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      ) : null}
      {ui && !onReview ? (
        <div data-slot="form-actions" className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={next} data-testid="step-form-next">
            {ui.next}
          </Button>
          <span className="text-xs text-muted-foreground">{ui.enterHint}</span>
          {back}
        </div>
      ) : (
        <div data-slot="form-actions" className="flex flex-wrap items-center gap-2">
          {footer}
          {back}
        </div>
      )}
    </form>
  );
}

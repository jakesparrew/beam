"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

/** Pause after the last keystroke before a typed filter (search text, a date) applies. */
const TYPING_DELAY_MS = 500;
/** Inputs whose value is typed, so they apply on Enter or after a pause, not on every key. */
const TYPED = new Set(["text", "search", "email", "tel", "number", "date", "month", "week", "time", "datetime-local", "url"]);

/** The URL a GET form would open: its action's path plus the form's fields, in order. */
export function filterHref(form: HTMLFormElement): string {
  const path = new URL(form.action || window.location.href, window.location.href).pathname;
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) if (typeof value === "string") params.append(key, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const isTyped = (el: EventTarget | null): boolean => el instanceof HTMLInputElement && TYPED.has(el.type);
const formOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLFormElement>("form[data-auto-filter]") : null);

/**
 * Owner review section 10: list filters apply as soon as staff pick a value, with no "Apply"
 * button. Mounted once in the admin shell, it serves every `<form method="get" data-auto-filter>`:
 * a select, checkbox or radio applies on change, a typed field on Enter or after a short pause.
 * The navigation is a client transition, so the field being typed in keeps its focus.
 */
export function AutoFilter() {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (form: HTMLFormElement) => {
      clearTimeout(timer);
      if (!form.checkValidity()) return;
      router.push(filterHref(form) as Route, { scroll: false });
    };
    const onChange = (e: Event) => {
      const form = formOf(e.target);
      if (form && !isTyped(e.target)) apply(form);
    };
    const onInput = (e: Event) => {
      const form = formOf(e.target);
      if (!form || !isTyped(e.target)) return;
      clearTimeout(timer);
      timer = setTimeout(() => apply(form), TYPING_DELAY_MS);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const form = formOf(e.target);
      if (!form || e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
      e.preventDefault();
      apply(form);
    };
    const onSubmit = (e: SubmitEvent) => {
      const form = formOf(e.target);
      if (!form) return;
      e.preventDefault();
      apply(form);
    };
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("submit", onSubmit);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("change", onChange);
      document.removeEventListener("input", onInput);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("submit", onSubmit);
    };
  }, [router]);
  return null;
}

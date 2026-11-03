"use client";

import { useId, useState } from "react";
import { cn } from "./cn";
import { Badge } from "./components/badge";
import { Input } from "./components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs";
import { Textarea } from "./components/textarea";

/** Structural twin of `@beam/core/i18n` `LocalizedText` (ui imports no core code). */
export type LocalizedValue<L extends string = string> = Partial<
  Record<L, string>
>;

export type LocalizedInputLabels<L extends string = string> = {
  /** Visible label of the field, for example "Title". */
  field: string;
  /** Name of each locale, for example `{ 'nl-BE': 'Nederlands', 'fr-BE': 'Français', en: 'English' }`. */
  locales: Record<L, string>;
  /** Badge text of an empty locale, for example "Missing". */
  missing: string;
  /** Badge text of a filled locale, for example "Complete". */
  complete: string;
};

export type LocalizedInputProps<L extends string = string> = {
  /** Form name: a hidden input carries the whole value as JSON under this name. */
  name: string;
  value: LocalizedValue<L>;
  /** Controlled mode when given; otherwise the component keeps its own state from `value`. */
  onChange?: (value: LocalizedValue<L>) => void;
  /** The locales to edit, in tab order (for example `LOCALES` or `webinars.locales`). */
  locales: readonly L[];
  multiline?: boolean;
  labels: LocalizedInputLabels<L>;
  /** Field-level error, shown under the tabs and linked to every locale input. */
  error?: string | null;
  disabled?: boolean;
  className?: string;
};

/** True when the locale has non-blank text (drafts may be partial; publishing checks all). */
function isFilled(value: LocalizedValue, locale: string): boolean {
  return (value[locale] ?? "").trim().length > 0;
}

/**
 * One text per locale in tabs, each tab with a completeness badge (architecture section
 * 6: three tabs, completeness badge). Publishing modules still call `assertComplete`.
 */
export function LocalizedInput<L extends string>({
  name,
  value,
  onChange,
  locales,
  multiline = false,
  labels,
  error,
  disabled,
  className,
}: LocalizedInputProps<L>) {
  const baseId = `localized-${useId().replace(/:/g, "")}`;
  const [inner, setInner] = useState<LocalizedValue<L>>(value);
  const current = onChange ? value : inner;
  const errorId = error ? `${baseId}-error` : undefined;

  const update = (locale: L, text: string) => {
    const next = { ...current, [locale]: text } as LocalizedValue<L>;
    if (onChange) onChange(next);
    else setInner(next);
  };

  const Control = multiline ? Textarea : Input;

  return (
    <div data-slot="localized-input" className={cn("grid gap-2", className)}>
      <span id={`${baseId}-label`} className="text-sm leading-none font-medium">
        {labels.field}
      </span>
      <input type="hidden" name={name} value={JSON.stringify(current)} />
      <Tabs defaultValue={locales[0]}>
        <TabsList aria-labelledby={`${baseId}-label`}>
          {locales.map((locale) => {
            const filled = isFilled(current, locale);
            return (
              <TabsTrigger
                key={locale}
                value={locale}
                data-locale={locale}
                data-complete={filled}
              >
                <span lang={locale}>{labels.locales[locale]}</span>
                <Badge
                  variant={filled ? "outline" : "destructive"}
                  data-slot="locale-badge"
                  data-locale={locale}
                  className="ml-1"
                >
                  {filled ? labels.complete : labels.missing}
                </Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
        {locales.map((locale) => {
          const inputId = `${baseId}-${locale}`;
          return (
            <TabsContent
              key={locale}
              value={locale}
              forceMount
              className="data-[state=inactive]:hidden"
            >
              <label htmlFor={inputId} className="sr-only">
                {`${labels.field} (${labels.locales[locale]})`}
              </label>
              <Control
                id={inputId}
                lang={locale}
                value={current[locale] ?? ""}
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                aria-describedby={errorId}
                onChange={(e: { target: { value: string } }) =>
                  update(locale, e.target.value)
                }
              />
            </TabsContent>
          );
        })}
      </Tabs>
      {error ? (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

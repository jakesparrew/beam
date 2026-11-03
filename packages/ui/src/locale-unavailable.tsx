import { LanguagesIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type LocaleAlternative = {
  /** BCP 47 locale code, for example `fr-BE`; set as `hrefLang` and `lang` on the link. */
  locale: string;
  /** The language name in that language, for example "Français". */
  label: string;
  href: string;
};

export type LocaleUnavailableProps = {
  /** For example "This page is not available in English". */
  title: ReactNode;
  description?: ReactNode;
  /** The locales the content is live in. */
  alternatives: LocaleAlternative[];
  /** Accessible name of the list of alternatives, for example "Available languages". */
  alternativesLabel?: string;
  className?: string;
};

/** Shown when content exists but not in the requested locale (no fallback language). */
export function LocaleUnavailable({
  title,
  description,
  alternatives,
  alternativesLabel,
  className,
}: LocaleUnavailableProps) {
  return (
    <section
      data-slot="locale-unavailable"
      className={cn(
        "flex flex-col items-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <LanguagesIcon className="size-8 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {alternatives.length > 0 ? (
        <ul
          aria-label={alternativesLabel}
          className="mt-2 flex flex-wrap justify-center gap-3"
        >
          {alternatives.map((alt) => (
            <li key={alt.locale}>
              <a
                href={alt.href}
                hrefLang={alt.locale}
                lang={alt.locale}
                className="font-medium text-primary underline underline-offset-4 hover:no-underline"
              >
                {alt.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

import { IntlMessageFormat } from "intl-messageformat";
import { MissingMessageError } from "../errors";
import { TIME_ZONE, type Locale } from "./locales";
import { MESSAGES, type MessageTree } from "./messages/index.generated";

export type { MessageTree };

/** A catalogue key `<module>.<screen>.<element>` (the catalogues are checked by `pnpm i18n:check`). */
export type MessageKey = string;

export type MessageParams = Record<string, string | number | Date>;

/** Catalogues per locale, each holding one tree per module whose root key is the module id. */
export type Catalogues = Readonly<Record<string, Readonly<Record<string, MessageTree>>>>;

export type MissingMessageMode = "throw" | "marker";

/** `⟦key⟧`, what a missing message renders as outside tests (PL-63). */
export function missingMarker(key: string): string {
  return `⟦${key}⟧`;
}

function defaultMode(): MissingMessageMode {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return env.NODE_ENV === "production" ? "marker" : "throw";
}

/** Walks `module.screen.element` through the module's tree (whose root key is the module id). */
export function lookupMessage(catalogues: Catalogues, locale: Locale, key: string): string | undefined {
  const [module] = key.split(".", 1);
  const tree = module ? catalogues[locale]?.[module] : undefined;
  let node: string | MessageTree | undefined = tree;
  for (const segment of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[segment];
  }
  return typeof node === "string" ? node : undefined;
}

export type Translator = {
  (locale: Locale, key: MessageKey, params?: MessageParams): string;
  has(locale: Locale, key: MessageKey): boolean;
};

/**
 * Builds a `t()` over the given catalogues. `onMissing` is called once per locale and key
 * (the runtime wires it to Sentry); `mode` decides between throwing and the `⟦key⟧` marker.
 */
export function createTranslator(
  catalogues: Catalogues,
  options: { mode?: MissingMessageMode | (() => MissingMessageMode); onMissing?: (locale: Locale, key: string) => void } = {},
): Translator {
  const cache = new Map<string, IntlMessageFormat>();
  const reported = new Set<string>();
  const mode = (): MissingMessageMode =>
    typeof options.mode === "function" ? options.mode() : (options.mode ?? defaultMode());

  const translate = ((locale: Locale, key: MessageKey, params?: MessageParams): string => {
    const id = `${locale}\u0000${key}`;
    let format = cache.get(id);
    if (!format) {
      const message = lookupMessage(catalogues, locale, key);
      if (message === undefined || message.trim() === "") {
        if (!reported.has(id)) {
          reported.add(id);
          options.onMissing?.(locale, key);
        }
        if (mode() === "throw") throw new MissingMessageError(locale, key);
        return missingMarker(key);
      }
      format = new IntlMessageFormat(message, locale, BRUSSELS_FORMATS, { ignoreTag: true });
      cache.set(id, format);
    }
    const out = format.format(params);
    return Array.isArray(out) ? out.join("") : String(out);
  }) as Translator;
  translate.has = (locale, key) => lookupMessage(catalogues, locale, key) !== undefined;
  return translate;
}

/** Dates passed as ICU params (`{at, date, long}`) are shown in Brussels time (PL-66). */
const BRUSSELS_FORMATS = {
  date: {
    short: { timeZone: TIME_ZONE, day: "numeric", month: "numeric", year: "2-digit" },
    medium: { timeZone: TIME_ZONE, day: "numeric", month: "short", year: "numeric" },
    long: { timeZone: TIME_ZONE, day: "numeric", month: "long", year: "numeric" },
    full: { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" },
  },
  time: {
    short: { timeZone: TIME_ZONE, hour: "numeric", minute: "numeric" },
    medium: { timeZone: TIME_ZONE, hour: "numeric", minute: "numeric", second: "numeric" },
    long: { timeZone: TIME_ZONE, hour: "numeric", minute: "numeric", timeZoneName: "short" },
    full: { timeZone: TIME_ZONE, hour: "numeric", minute: "numeric", timeZoneName: "short" },
  },
} as const;

let missingHandler: ((locale: Locale, key: string) => void) | undefined;

/** The runtime (`lib/i18n.ts`, Sentry) registers its once-per-key reporter here. */
export function setMissingMessageHandler(handler: ((locale: Locale, key: string) => void) | undefined): void {
  missingHandler = handler;
}

/**
 * `t(locale, key, params)` over the generated catalogues, for email and job code that has
 * no React context. Throws `MissingMessageError` in tests and development, renders `⟦key⟧`
 * in production (PL-63). Never shows another language.
 */
export const t: Translator = createTranslator(MESSAGES, {
  onMissing: (locale, key) => missingHandler?.(locale, key),
});

/** The merged message object of the given modules for one locale (`next-intl` per route group). */
export function messagesFor(locale: Locale, modules?: readonly string[]): Record<string, MessageTree> {
  const all = MESSAGES[locale] ?? {};
  const out: Record<string, MessageTree> = {};
  for (const [module, tree] of Object.entries(all)) {
    if (modules && !modules.includes(module)) continue;
    Object.assign(out, tree);
  }
  return out;
}



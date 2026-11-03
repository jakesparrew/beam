/**
 * `@beam/core`: pure domain logic and Zod schemas, no I/O (architecture section 1).
 *
 * Import a subpath, never this root: `@beam/core/<module>` (for example
 * `@beam/core/booking`), `@beam/core/i18n`, `@beam/core/errors`, `@beam/core/ai`,
 * `@beam/core/privacy`. Keeping the root empty means no module's code is pulled into
 * a bundle through a barrel file.
 */
export {};

/**
 * `@beam/integrations`: provider clients and their fakes (architecture section 8).
 *
 * Import a subpath, never this root: `@beam/integrations/<provider>` (index),
 * `@beam/integrations/<provider>/client`, `@beam/integrations/<provider>/fake`,
 * `@beam/integrations/<provider>/types` and `@beam/integrations/_shared`. Keeping the
 * root empty means importing one fake never loads every provider SDK. The Anthropic
 * SDK is imported only under `src/anthropic/` (PL-51, enforced by ESLint).
 */
export {};

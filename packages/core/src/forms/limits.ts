/**
 * The F7 and F4 limits of a form definition. A module of its own without zod, so the browser
 * form engine (`logic.ts`, used by the public form renderer) does not pull the schemas of
 * `definition.ts` and zod into the public site's JavaScript (site rule 51).
 */
/** Rule F7 and F4. */
export const FORM_LIMITS = {
  sections: 30,
  fields: 200,
  outcomes: 50,
  dimensions: 20,
  logicRules: 100,
  bytes: 256 * 1024,
  conditionDepth: 6,
  conditionLeaves: 50,
  optionsMin: 2,
  optionsMax: 50,
  ctas: 4,
  shortText: 255,
  longText: 5000,
  acknowledgementText: 5000,
} as const;

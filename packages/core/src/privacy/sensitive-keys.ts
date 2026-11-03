/**
 * Special-category data keys (architecture section 4, PL-54). Values under these keys live
 * only in `person_sensitive_fields`, `form_sensitive_answers` and sensitive `activity_events`,
 * are read only through `readSensitive()`, and never reach AI context, segments, exports or logs.
 * `form_versions.sensitive_field_keys` entries are sensitive too (checked by `isSensitiveFieldKey`
 * callers with the form's own list).
 */
export const SENSITIVE_FIELD_KEYS = ["health_note", "sleep", "stress", "recovery", "wellbeing", "medical"] as const;

export type SensitiveFieldKey = (typeof SENSITIVE_FIELD_KEYS)[number];

export function isSensitiveFieldKey(key: string): key is SensitiveFieldKey {
  return (SENSITIVE_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * True when `key` (a field key, or a dotted path whose last segment is a field key) is
 * sensitive, either by the fixed list or because a form version marked it sensitive.
 */
export function isSensitiveKey(key: string, extraSensitiveKeys: readonly string[] = []): boolean {
  const last = key.split(".").pop() ?? key;
  return isSensitiveFieldKey(last) || extraSensitiveKeys.includes(key) || extraSensitiveKeys.includes(last);
}

/** Key names that are secrets, never written to audit values or logs (PL-21). */
export const SECRET_KEY_PATTERN = /password|token|secret|totp|recovery|_enc$/i;

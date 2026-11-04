/**
 * Polls and timed items (webinar spec rules 33-35). A poll accepts one answer per registration
 * per mode; option keys must exist on the poll and `allow_multiple = false` accepts exactly one.
 * Tag rules apply when their option keys intersect the answer and their modes include the mode.
 */
import type { PollDefinition, TimedItem, WatchMode } from "./types";

export type PollAnswerError = "empty" | "unknown_option" | "duplicate_option" | "multiple_not_allowed";

/** `optionKeys` is the answer in the poll's option order. */
export type PollAnswerResult = { ok: true; optionKeys: string[] } | { ok: false; code: PollAnswerError; unknown?: string[] };
/** The name the package contract uses (`validatePollAnswer(poll, optionKeys): Result`). */
export type Result = PollAnswerResult;

/** Validates an answer against its poll (rule 33). */
export function validatePollAnswer(poll: Pick<PollDefinition, "options" | "allowMultiple">, optionKeys: readonly string[]): PollAnswerResult {
  if (optionKeys.length === 0) return { ok: false, code: "empty" };
  const known = poll.options.map((o) => o.key);
  const unknown = optionKeys.filter((k) => !known.includes(k));
  if (unknown.length) return { ok: false, code: "unknown_option", unknown: [...new Set(unknown)] };
  if (new Set(optionKeys).size !== optionKeys.length) return { ok: false, code: "duplicate_option" };
  if (!poll.allowMultiple && optionKeys.length !== 1) return { ok: false, code: "multiple_not_allowed" };
  return { ok: true, optionKeys: known.filter((k) => optionKeys.includes(k)) };
}

/**
 * The tag keys an answer applies (rule 35): every rule whose `option_keys` intersect the answer
 * and whose `modes` include `mode`, unique, in rule order. Unknown tags are filtered later by
 * the caller (edge case 16).
 */
export function tagsForAnswer(poll: Pick<PollDefinition, "tagRules">, optionKeys: readonly string[], mode: WatchMode): string[] {
  const out: string[] = [];
  for (const rule of poll.tagRules) {
    if (!rule.modes.includes(mode)) continue;
    if (!rule.option_keys.some((k) => optionKeys.includes(k))) continue;
    if (!out.includes(rule.tag_key)) out.push(rule.tag_key);
  }
  return out;
}

/** `data.option_key` of `webinar.poll_answered`: the single chosen key, or null for several (rule 35). */
export function answerOptionKey(optionKeys: readonly string[]): string | null {
  return optionKeys.length === 1 ? optionKeys[0]! : null;
}

/**
 * The items shown at a video position outside live (rule 34): active items with a
 * `show_at_sec`, inside `[show_at_sec, show_at_sec + show_for_sec)`. An item without
 * `show_at_sec` never appears outside live. Order is kept.
 */
export function visibleAt<T extends TimedItem>(items: readonly T[], positionSec: number): T[] {
  return items.filter(
    (i) => i.isActive !== false && i.showAtSec !== null && positionSec >= i.showAtSec && positionSec < i.showAtSec + i.showForSec,
  );
}

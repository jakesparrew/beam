/**
 * A word-level diff of one field (site spec section 5 review screen): insertions in green with an
 * underline, deletions in red struck through, unchanged text plain. `ins`/`del` keep the meaning
 * for screen readers; colour is never the only signal (WCAG 1.4.1).
 */
import type { DiffSegment } from "@beam/core/site";

export function DiffText({ segments, empty = "—" }: { segments: DiffSegment[]; empty?: string }) {
  if (!segments.length) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((s, i) =>
        s.op === "ins" ? (
          <ins key={i} data-diff="ins" className="rounded-sm bg-green-100 text-green-900 underline decoration-green-700 dark:bg-green-950 dark:text-green-100">
            {s.text}
          </ins>
        ) : s.op === "del" ? (
          <del key={i} data-diff="del" className="rounded-sm bg-red-100 text-red-900 line-through decoration-red-700 dark:bg-red-950 dark:text-red-100">
            {s.text}
          </del>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

/** Only the new side of a diff (what the version says). */
export function newText(segments: DiffSegment[]): string {
  return segments.filter((s) => s.op !== "del").map((s) => s.text).join("");
}

/** `rich_text` block: a `RichDoc` through the in-house renderer (rule 19). */
import type { BlockOf } from "../block-renderer";
import { RichText } from "../rich-text";

export function RichTextBlockView({ block }: { block: BlockOf<"rich_text"> }) {
  return <RichText doc={block.doc} />;
}

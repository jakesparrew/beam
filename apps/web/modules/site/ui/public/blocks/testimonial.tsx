/** `testimonial` block (rule 21): a quote whose author agreed to be quoted (`consentConfirmed`). */
import type { BlockOf } from "../block-renderer";

export function TestimonialBlockView({ block }: { block: BlockOf<"testimonial"> }) {
  return (
    <figure className="mx-auto max-w-3xl space-y-4 text-center">
      <blockquote className="text-xl leading-relaxed italic">
        <p>“{block.quote}”</p>
      </blockquote>
      <figcaption className="text-sm">
        <span className="font-semibold">{block.authorName}</span>
        {block.authorDetail ? <span className="text-muted-foreground">, {block.authorDetail}</span> : null}
      </figcaption>
    </figure>
  );
}

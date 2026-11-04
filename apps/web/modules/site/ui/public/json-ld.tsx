/**
 * JSON-LD data blocks of a page (site spec section 5). `serializeJsonLd` escapes `<`, `>` and `&`,
 * so content can never close the script element; a data block is never executed.
 */
import { serializeJsonLd } from "@beam/core/site";

export function JsonLd({ items }: { items: readonly object[] }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((item, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(item) }} />
      ))}
    </>
  );
}

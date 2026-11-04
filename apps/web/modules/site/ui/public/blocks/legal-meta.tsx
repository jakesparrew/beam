/** `legal_meta` block: "Version n, last updated <date>" from `v_legal_versions` (legal pages only). */
import { formatDate } from "@beam/core/i18n";
import type { BlockContext } from "../block-renderer";

export function LegalMetaBlockView({ ctx }: { ctx: BlockContext }) {
  const meta = ctx.data.legalMeta;
  if (!meta) return null;
  return (
    <p className="text-sm text-muted-foreground" data-legal-version={meta.ordinal}>
      {ctx.tr("site.blocks.legal.version", { n: meta.ordinal })} · {ctx.tr("site.blocks.legal.updated", { date: formatDate(meta.publishedAt, ctx.locale, "long") })}
    </p>
  );
}

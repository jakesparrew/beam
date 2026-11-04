/**
 * `renderInvoicePdf(model)`: the invoice PDF bytes (finance-P3, `@react-pdf/renderer`). The
 * document information (title, author, subject, language, creation date) comes from the model,
 * and the creation date is the document's `issued_at`, so the same document renders the same
 * text and metadata every time.
 *
 * The pure document model lives in `packages/core/src/finance/document-model.ts`. `@beam/core`
 * exports a module only through `src/<m>/index.ts`, which this package does not own, so the
 * model is imported here by path and re-exported for the rest of the finance module (request:
 * finance's `packages/core/src/finance/index.ts` adds `export * from "./document-model"`, then
 * this file imports `@beam/core/finance`).
 */
import "server-only";
import { createElement, type ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import type { InvoiceDocumentModel } from "../../../../../packages/core/src/finance/document-model";
import { InvoiceDocument } from "./invoice-document";

export {
  assertRenderableSeller,
  buildInvoiceDocumentModel,
  formatIban,
  MissingCompanySettingsError,
  type DocumentColumn,
  type DocumentField,
  type DocumentRow,
  type InvoiceDocumentModel,
} from "../../../../../packages/core/src/finance/document-model";

/** Renders the document model to PDF bytes (A4, `%PDF-` header). */
export async function renderInvoicePdf(model: InvoiceDocumentModel): Promise<Uint8Array> {
  const element = createElement(InvoiceDocument, { model }) as unknown as ReactElement<DocumentProps>;
  const buffer = await renderToBuffer(element);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

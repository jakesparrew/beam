/**
 * `renderInvoicePdf(model)`: the invoice PDF bytes (finance-P3, `@react-pdf/renderer`). The
 * document information (title, author, subject, language, creation date) comes from the model,
 * and the creation date is the document's `issued_at`, so the same document renders the same
 * text and metadata every time.
 *
 * The pure document model lives in `@beam/core/finance` (`document-model.ts`); it is re-exported
 * here for the rest of the finance module.
 */
import "server-only";
import { createElement, type ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import type { InvoiceDocumentModel } from "@beam/core/finance";
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
} from "@beam/core/finance";

/** Renders the document model to PDF bytes (A4, `%PDF-` header). */
export async function renderInvoicePdf(model: InvoiceDocumentModel): Promise<Uint8Array> {
  const element = createElement(InvoiceDocument, { model }) as unknown as ReactElement<DocumentProps>;
  const buffer = await renderToBuffer(element);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

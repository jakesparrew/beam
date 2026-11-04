/**
 * The invoice and credit-note PDF (finance rules 36 and 37), drawn from an
 * `InvoiceDocumentModel` only: every string is already resolved in the document locale, so this
 * component holds layout and nothing else. The line table header and the footer with the page
 * number repeat on every page.
 */
import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { DocumentColumn, InvoiceDocumentModel } from "./render";
import { COLUMN_WIDTHS, styles } from "./styles";

function cellStyle(column: DocumentColumn) {
  return [styles.cell, { width: COLUMN_WIDTHS[column.key] }, column.align === "right" ? styles.right : {}];
}

export function InvoiceDocument({ model }: { model: InvoiceDocumentModel }) {
  const m = model;
  const [description, quantity, unit, vatRate, amount] = m.columns;
  return (
    <Document
      title={m.meta.title}
      author={m.meta.author}
      subject={m.meta.subject}
      creator={m.meta.creator}
      producer={m.meta.producer}
      language={m.meta.language}
      creationDate={new Date(m.meta.createdAt)}
      modificationDate={new Date(m.meta.createdAt)}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.block}>
            <Text style={styles.sellerName}>{m.seller.name}</Text>
            {m.seller.lines.map((line, i) => (
              <Text key={i} style={styles.small}>
                {line}
              </Text>
            ))}
          </View>
          <View style={styles.block}>
            <Text style={styles.heading}>{m.heading}</Text>
            <Text style={styles.reference}>{m.number}</Text>
            {m.reference ? <Text style={styles.reference}>{m.reference}</Text> : null}
          </View>
        </View>

        <View style={styles.parties}>
          <View style={styles.block}>
            <Text style={styles.blockLabel}>{m.customer.label}</Text>
            <Text style={styles.customerName}>{m.customer.name}</Text>
            {m.customer.lines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </View>
          <View style={styles.block}>
            {m.facts.map((f, i) => (
              <View key={i} style={styles.factRow}>
                <Text style={styles.factLabel}>{f.label}</Text>
                <Text style={styles.factValue}>{f.value}</Text>
              </View>
            ))}
          </View>
        </View>

        {m.reason ? (
          <View style={styles.reason}>
            <Text>
              {m.reason.label}: {m.reason.value}
            </Text>
          </View>
        ) : null}

        <View style={styles.tableHeader} fixed>
          {m.columns.map((c) => (
            <Text key={c.key} style={cellStyle(c)}>
              {c.label}
            </Text>
          ))}
        </View>
        {m.rows.map((r, i) => (
          <View key={i} style={styles.row} wrap={false}>
            <View style={cellStyle(description!)}>
              <Text>{r.description}</Text>
              {r.details.map((d, j) => (
                <Text key={j} style={styles.detail}>
                  {d}
                </Text>
              ))}
            </View>
            <Text style={cellStyle(quantity!)}>{r.quantity}</Text>
            <Text style={cellStyle(unit!)}>{r.unit}</Text>
            <Text style={cellStyle(vatRate!)}>{r.vatRate}</Text>
            <Text style={cellStyle(amount!)}>{r.amount}</Text>
          </View>
        ))}

        <View style={styles.summary} wrap={false}>
          <View style={styles.breakdown}>
            <Text style={styles.breakdownTitle}>{m.breakdown.title}</Text>
            <View style={styles.breakdownRow}>
              {m.breakdown.columns.map((c, i) => (
                <Text key={i} style={[styles.breakdownCell, styles.small]}>
                  {c}
                </Text>
              ))}
            </View>
            {m.breakdown.rows.map((row, i) => (
              <View key={i} style={styles.breakdownRow}>
                {row.map((v, j) => (
                  <Text key={j} style={styles.breakdownCell}>
                    {v}
                  </Text>
                ))}
              </View>
            ))}
          </View>
          <View style={styles.totals}>
            {m.totals.map((tot, i) => (
              <View key={i} style={tot.strong ? [styles.totalRow, styles.totalStrong] : styles.totalRow}>
                <Text>{tot.label}</Text>
                <Text>{tot.value}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.payment} wrap={false}>
          <Text style={styles.paymentTitle}>{m.payment.title}</Text>
          {m.payment.lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{m.footer}</Text>
          <Text
            style={styles.pageNumber}
            render={({ pageNumber, totalPages }) => m.pageLabel.replace("{x}", String(pageNumber)).replace("{y}", String(totalPages))}
          />
        </View>
      </Page>
    </Document>
  );
}

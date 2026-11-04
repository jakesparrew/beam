/**
 * Styles of the invoice PDF (A4, the built-in Helvetica family, so rendering needs no font
 * download and stays identical across machines). Sizes in points.
 */
import { StyleSheet } from "@react-pdf/renderer";

export const COLORS = { ink: "#1f2421", muted: "#5f6b66", line: "#d5dbd8", accent: "#2f5d50", band: "#f1f4f2" } as const;

/** Column widths of the line table, in the order of `InvoiceDocumentModel.columns`. */
export const COLUMN_WIDTHS = { description: "44%", quantity: "8%", unit: "19%", vat_rate: "10%", amount: "19%" } as const;

export const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 56, paddingHorizontal: 44, fontFamily: "Helvetica", fontSize: 9, color: COLORS.ink, lineHeight: 1.25 },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  sellerName: { fontFamily: "Helvetica-Bold", fontSize: 13, color: COLORS.accent, marginBottom: 3 },
  small: { fontSize: 8, color: COLORS.muted },
  heading: { fontFamily: "Helvetica-Bold", fontSize: 20, textAlign: "right" },
  reference: { fontSize: 9, textAlign: "right", marginTop: 3 },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  block: { width: "48%" },
  blockLabel: { fontSize: 7.5, color: COLORS.muted, textTransform: "uppercase", marginBottom: 3 },
  customerName: { fontFamily: "Helvetica-Bold", fontSize: 10.5, marginBottom: 2 },
  factRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 1.5 },
  factLabel: { color: COLORS.muted },
  factValue: { fontFamily: "Helvetica-Bold" },
  reason: { marginBottom: 12, padding: 6, backgroundColor: COLORS.band },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.ink,
    paddingBottom: 3,
    marginBottom: 2,
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
  },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: COLORS.line, paddingVertical: 2 },
  cell: { paddingRight: 4 },
  right: { textAlign: "right" },
  detail: { fontSize: 7, color: COLORS.muted },
  summary: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  breakdown: { width: "52%" },
  breakdownTitle: { fontFamily: "Helvetica-Bold", fontSize: 8.5, marginBottom: 3 },
  breakdownRow: { flexDirection: "row", paddingVertical: 1.5 },
  breakdownCell: { width: "25%", textAlign: "right" },
  totals: { width: "40%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  totalStrong: { fontFamily: "Helvetica-Bold", fontSize: 11, borderTopWidth: 1, borderTopColor: COLORS.ink, paddingTop: 4, marginTop: 2 },
  payment: { marginTop: 10, padding: 6, backgroundColor: COLORS.band },
  paymentTitle: { fontFamily: "Helvetica-Bold", marginBottom: 3 },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: COLORS.line,
    paddingTop: 5,
    fontSize: 7,
    color: COLORS.muted,
  },
  footerText: { width: "80%" },
  pageNumber: { width: "20%", textAlign: "right" },
});

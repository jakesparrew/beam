/**
 * Check-in QR codes (booking spec R59, `bookings.checkin_code` and `qr_file_id`). The QR holds
 * the booking's 10-character Crockford check-in code (reception scans it into `checkIn`). The PNG
 * is stored once through platform's `storeFile` and travels in emails as the inline attachment
 * `checkin-qr.png` (`<img src="cid:checkin-qr.png">`); no signed URL is put in an email.
 */
import QRCode from "qrcode";
import { bookings } from "@beam/db/schema";
import { eq, type Ctx } from "@/lib/ctx";
import { storeFile } from "@/lib/files";

/** The inline attachment name the booking templates reference (`cid:checkin-qr.png`). */
export const CHECKIN_QR_FILENAME = "checkin-qr.png";

/** PNG bytes of a QR code for `code`. */
export async function checkinQrPng(code: string): Promise<Uint8Array> {
  const buffer = await QRCode.toBuffer(code, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 320 });
  return new Uint8Array(buffer);
}

/** An inline SVG of the QR code (portal booking page; never stored). */
export function checkinQrSvg(code: string): Promise<string> {
  return QRCode.toString(code, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
}

/**
 * Renders and stores the booking's QR code once and returns its file id; a booking that already
 * has `qr_file_id` returns it unchanged. Setting `qr_file_id` does not bump the booking version
 * (it is derived data, not a state change).
 */
export async function renderCheckinQr(
  ctx: Ctx,
  booking: { id: string; personId: string; checkinCode: string; qrFileId?: string | null },
): Promise<string> {
  if (booking.qrFileId) return booking.qrFileId;
  const [current] = await ctx.tx.select({ qrFileId: bookings.qrFileId }).from(bookings).where(eq(bookings.id, booking.id));
  if (current?.qrFileId) return current.qrFileId;
  const bytes = await checkinQrPng(booking.checkinCode);
  const { fileId } = await storeFile(ctx, { kind: "image", name: CHECKIN_QR_FILENAME, mime: "image/png", bytes, personId: booking.personId });
  await ctx.tx.update(bookings).set({ qrFileId: fileId }).where(eq(bookings.id, booking.id));
  return fileId;
}

/** The `attachments` entry of a booking email. */
export function qrAttachment(fileId: string): { fileId: string; filename: string; inline: true } {
  return { fileId, filename: CHECKIN_QR_FILENAME, inline: true };
}
